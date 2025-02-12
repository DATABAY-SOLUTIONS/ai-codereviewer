// src/main.ts

import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI, {
  ChatCompletionMessageParam,
  ChatCompletion,
} from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, {
  File,
  Chunk,
  Change,
  AddChange,
  DelChange,
  NormalChange,
} from "parse-diff";
import minimatch from "minimatch";

/** Utility to determine a line number string for each type of change. */
function getLineNumber(change: Change): string {
  switch (change.type) {
    case "add":
      // AddChange has `ln2`
      return String((change as AddChange).ln2);
    case "del":
      // DelChange has `ln`
      return String((change as DelChange).ln);
    default:
      // NormalChange (there can be ln1, ln2, etc.)
      const normal = change as NormalChange;
      // For simplicity, just return ln2 if present
      return normal.ln2 ? String(normal.ln2) : "";
  }
}

// These come from your GitHub Action inputs/secrets
const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

/** Fetch basic PR details. */
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

/** Fetch the diff of the pull request as a string. */
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
  // The GitHub API returns the diff as a string in `response.data`
  return response.data as unknown as string;
}

/** Main code analysis logic: loops through each file/chunk, calls GPT, builds comments. */
async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    // Ignore deleted files
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

/** Creates a prompt for OpenAI based on the chunk content. */
function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  // Convert chunk changes into a single string of "lineNumber content"
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

/** Call OpenAI ChatCompletion and parse the returned JSON. */
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
    // Build a valid array of ChatCompletionMessageParam
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: prompt,
      },
    ];

    // Make the GPT call
    const response: ChatCompletion = await openai.chat.completions.create({
      ...queryConfig,
      messages,
    });

    // Attempt to parse GPT output as JSON: { "reviews": [ ... ] }
    const raw = response.choices[0].message?.content?.trim() || "{}";
    return JSON.parse(raw).reviews;
  } catch (error) {
    console.error("OpenAI Error:", error);
    return null;
  }
}

/** Convert the AI "reviews" into the structure expected by GitHub's createReview. */
function createComment(
  file: File,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.map((aiResponse) => ({
    body: aiResponse.reviewComment,
    path: file.to || "",
    line: Number(aiResponse.lineNumber),
  }));
}

/** Submit the collected review comments to GitHub. */
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

/** Main entry point. */
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

    // Compare commits to get a diff
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

  // Parse the diff into a structured object
  const parsedDiff = parseDiff(diff);

  // Exclude certain files from the analysis
  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) => {
      if (!file.to) return false;
      return minimatch(file.to, pattern);
    });
  });

  // Analyze the final set of files
  const comments = await analyzeCode(filteredDiff, prDetails);

  // If we have suggestions, submit them
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

// Run the action
main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
