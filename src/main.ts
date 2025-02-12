// src/main.ts

import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { File, Chunk, Change } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Initialize the new OpenAI client
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

/**
 * Local minimal type for an OpenAI chat message.
 * Adjust as needed or replace with official types
 * if your openai library version provides them.
 */
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 
 * If you want a fully typed response, define your own shape.
 * For now, we'll just keep it flexible enough for the `.choices[0].message?.content`.
 */
interface OpenAIChatResponse {
  choices: Array<{
    message?: {
      role: string;
      content?: string;
    };
  }>;
}

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // The diff is a string on response.data
  return response.data as unknown as string;
}

/**
 * Safely extract a line number from a parse-diff Change object
 * without referencing any out-of-date or missing type fields.
 */
function getLineNumber(change: Change): string {
  // Some parse-diff versions define "ln" or "ln2", some define "oldLine"/"newLine"
  // We'll just check ln2, then ln, then fallback to empty string
  if ("ln2" in change && change.ln2 !== undefined) {
    return String(change.ln2);
  } else if ("ln" in change && change.ln !== undefined) {
    return String(change.ln);
  }
  return "";
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    // Skip deleted files
    if (file.to === "/dev/null") continue;

    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  // Build the diff snippet as lines of "lineNumber content"
  const diffText = chunk.changes
    .map((change) => `${getLineNumber(change)} ${change.content}`)
    .join("\n");

  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${diffText}
\`\`\`
`;
}

/**
 * Calls OpenAI ChatCompletion endpoint, returns parsed "reviews" array from the JSON.
 */
async function getAIResponse(
  prompt: string
): Promise<Array<{ lineNumber: string; reviewComment: string }> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    // Build the messages array
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: prompt,
      },
    ];

    // We can type-cast the result or leave it as any
    const response = (await openai.chat.completions.create({
      ...queryConfig,
      messages,
    })) as unknown as OpenAIChatResponse;

    // Parse the text as JSON: { "reviews": [ ... ] }
    const rawText = response.choices[0].message?.content?.trim() || "{}";
    return JSON.parse(rawText).reviews;
  } catch (error) {
    console.error("OpenAI Error:", error);
    return null;
  }
}

/**
 * Convert the AI response into GitHub review comments format.
 */
function createComment(
  file: File,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.map((resp) => ({
    body: resp.reviewComment,
    path: file.to ?? "",
    line: Number(resp.lineNumber),
  }));
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  const prDetails = await getPRDetails();
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  let diff: string | null = null;

  if (eventData.action === "opened") {
    diff = await getDiff(prDetails.owner, prDetails.repo, prDetails.pull_number);
  } else if (eventData.action === "synchronize") {
    const baseSha = eventData.before;
    const headSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: baseSha,
      head: headSha,
    });
    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  // Optionally exclude certain paths
  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    if (!file.to) return false;
    // If any exclude pattern matches, skip
    return !excludePatterns.some((pattern) => minimatch(file.to || "", pattern));
  });

  // Get the suggestions from GPT
  const comments = await analyzeCode(filteredDiff, prDetails);

  // If GPT returned comments, post them
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
