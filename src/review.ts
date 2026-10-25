// Runs inside GitHub Actions on a pull_request_target event. Starts a Managed
// Agents session that reviews the PR, waits for it to finish, and posts the
// agent's findings back to the PR as a single review.

import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import { readFileSync } from "node:fs";
import { AGENT_NAME, ENVIRONMENT_NAME, REVIEW_OUTPUT_PATH, VAULT_NAME } from "./agent.ts";
import { isCommentable, parseDiffLines } from "./diff.ts";
import { findAgent, findEnvironment, findVault } from "./lookup.ts";

const SESSION_DEADLINE_MS = 25 * 60 * 1000;
const MAX_INLINE_COMMENTS = 25;

type ReviewComment = {
  path: string;
  line: number;
  start_line?: number;
  severity?: string;
  body: string;
  verdict?: string;
  verdict_reason?: string;
};
type Rating = { level?: string; reason?: string };
type Review = { summary: string; review_effort?: Rating; risk?: Rating; comments: ReviewComment[] };

const RISK_LABELS: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };
const VERDICT_LABELS: Record<string, string> = {
  valid: "Valid",
  unlikely: "Unlikely",
  not_worth_fixing: "Not worth fixing",
  incorrect: "Incorrect",
};

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const event = JSON.parse(readFileSync(env("GITHUB_EVENT_PATH"), "utf8"));
const pr = event.pull_request;
if (!pr) throw new Error("This action only runs on pull_request or pull_request_target events.");

const [owner, repo] = env("GITHUB_REPOSITORY").split("/");
const budgetUsd = Number(process.env.INPUT_BUDGET_USD || "7.5");
const extraInstructions = process.env.INPUT_EXTRA_INSTRUCTIONS?.trim() ?? "";
const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim() || "default";

const octokit = new Octokit({ auth: env("GITHUB_TOKEN") });
// Uses ANTHROPIC_API_KEY when set, otherwise Workload Identity Federation via the
// ANTHROPIC_FEDERATION_* variables and the GitHub OIDC token file.
const client = new Anthropic();

// --- Gather the PR's diff and pick the commit to clone -----------------------

const { data: diff } = await octokit.pulls.get({
  owner,
  repo,
  pull_number: pr.number,
  mediaType: { format: "diff" },
});
const diffText = diff as unknown as string;

// Clone the merge base and have the agent apply the diff on top, so the PR's
// changes are the working tree's uncommitted diff, which is what /code-review
// reviews. The merge base is always in the base repo, fork PRs included.
let checkoutSha: string = pr.base.sha;
try {
  const { data } = await octokit.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${pr.base.sha}...${pr.head.sha}`,
    per_page: 1,
  });
  checkoutSha = data.merge_base_commit.sha;
} catch (err) {
  console.log(`Could not find the merge base, cloning the base branch tip instead: ${err}`);
}

// --- Look for this bot's last review on the PR ----------------------------------

// Only reviews that finished carry this marker in their footer, so a failed run
// never counts as the review a follow-up builds on.
const REVIEW_MARKER = "Reviewed by Claude (Managed Agents)";

async function compareDiff(basehead: string): Promise<string> {
  const { data } = await octokit.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead,
    mediaType: { format: "diff" },
  });
  return data as unknown as string;
}

const reviews = await octokit.paginate(octokit.pulls.listReviews, {
  owner,
  repo,
  pull_number: pr.number,
  per_page: 100,
});
const previous = reviews
  .filter((r) => r.user?.type === "Bot" && r.commit_id && r.body?.includes(REVIEW_MARKER))
  .at(-1);

let previousReview = "";
let followUp: { since: string; reviewedDiff: string; newDiff: string } | undefined;
if (previous?.commit_id) {
  const previousComments = await octokit.paginate(octokit.pulls.listCommentsForReview, {
    owner,
    repo,
    pull_number: pr.number,
    review_id: previous.id,
    per_page: 100,
  });
  previousReview = [
    previous.body ?? "",
    ...previousComments.map((c) => `### ${c.path}:${c.line ?? c.original_line}\n\n${c.body}`),
  ].join("\n\n");

  // Only the new commits are reviewed when they sit on top of the reviewed head
  // and the PR still branches from the same merge base. After a rebase or a merge
  // from the base branch, their diff would mix in changes from outside the PR.
  if (previous.commit_id !== pr.head.sha) {
    try {
      const [{ data: sinceThen }, { data: before }] = await Promise.all([
        octokit.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${previous.commit_id}...${pr.head.sha}`, per_page: 1 }),
        octokit.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${pr.base.sha}...${previous.commit_id}`, per_page: 1 }),
      ]);
      if (sinceThen.status === "ahead" && before.merge_base_commit.sha === checkoutSha) {
        const [reviewedDiff, newDiff] = await Promise.all([
          compareDiff(`${checkoutSha}...${previous.commit_id}`),
          compareDiff(`${previous.commit_id}...${pr.head.sha}`),
        ]);
        // New commits that cancel out (a commit and its revert) leave nothing to review on its own.
        if (newDiff.trim()) followUp = { since: previous.commit_id, reviewedDiff, newDiff };
      }
    } catch (err) {
      console.log(`Could not diff against the last review, reviewing the whole PR: ${err}`);
    }
  }
}
console.log(
  followUp
    ? `Follow-up review of the commits since ${followUp.since}.`
    : previous
      ? `Re-reviewing the whole PR; last reviewed at ${previous.commit_id}.`
      : "First review of this PR.",
);

// --- Start the session ------------------------------------------------------

const [agent, environment, vault] = await Promise.all([
  findAgent(client, AGENT_NAME),
  findEnvironment(client, ENVIRONMENT_NAME),
  findVault(client, VAULT_NAME),
]);
if (!agent || !environment) {
  throw new Error(
    `Agent "${AGENT_NAME}" or environment "${ENVIRONMENT_NAME}" not found in this Anthropic org. ` +
      `Run the "Set up reviewer agent" workflow in the claude-review repo first.`,
  );
}
if (!vault) {
  throw new Error(
    `Vault "${VAULT_NAME}" not found. Create it in the Console with an ANTHROPIC_API_KEY ` +
      `environment-variable credential for Claude Code (see the README).`,
  );
}

async function upload(name: string, text: string) {
  const file = await client.files.upload({
    file: await toFile(Buffer.from(text, "utf8"), name, { type: "text/plain" }),
  });
  return { type: "file" as const, file_id: file.id, mount_path: `/${name}` };
}

const files = await Promise.all([
  upload("pr.diff", diffText),
  ...(previousReview ? [upload("previous-review.md", previousReview)] : []),
  ...(followUp ? [upload("reviewed.diff", followUp.reviewedDiff), upload("new.diff", followUp.newDiff)] : []),
]);

const message = [
  `Review pull request #${pr.number} in ${owner}/${repo}.`,
  `Base branch: ${pr.base.ref}. Head branch: ${pr.head.label}.`,
  `The repo is checked out at the merge base ${checkoutSha}.`,
  followUp
    ? `This is a follow-up review. Your last review covered the PR up to ${followUp.since}; it is in ` +
      `previous-review.md. reviewed.diff holds the changes it covered and new.diff the commits since.`
    : previous
      ? `This PR was reviewed before, at ${previous.commit_id}; that review is in previous-review.md. ` +
        `The commits since then can't be reviewed on their own (the PR was rebased or the base branch ` +
        `was merged in, or there are none), so review the whole PR.`
      : "This is the first review of this PR.",
  // Project settings would let the PR add hooks or MCP servers to Claude Code,
  // so only user settings load. The budget caps Claude Code's own spend.
  `Run this from the repo root, with EFFORT replaced by the level you pick:\n\`\`\`\nIS_SANDBOX=1 claude -p "/code-review EFFORT" --dangerously-skip-permissions ` +
    `--model claude-opus-5-5 --effort EFFORT --setting-sources user --strict-mcp-config --max-budget-usd ${budgetUsd} > /tmp/code-review.md\n\`\`\``,
  `<pr_title>${pr.title}</pr_title>`,
  `<pr_description>\n${pr.body ?? "(none)"}\n</pr_description>`,
  extraInstructions &&
    `Additional context from the repo owner, for converting findings (not for the /code-review prompt):\n${extraInstructions}`,
  `Write your review to ${REVIEW_OUTPUT_PATH} when you're done.`,
]
  .filter(Boolean)
  .join("\n\n");

const session = await client.beta.sessions.create({
  agent: agent.id,
  environment_id: environment.id,
  vault_ids: [vault.id],
  title: `${owner}/${repo}#${pr.number}: ${pr.title}`.slice(0, 200),
  metadata: { repo: `${owner}/${repo}`, pr: String(pr.number), head_sha: pr.head.sha },
  budget: {
    type: "limit",
    max_list_cost: { amount: String(Math.round(budgetUsd * 100)), currency: "USD" },
  },
  resources: [
    {
      type: "github_repository",
      url: pr.base.repo.html_url,
      // The Actions token is injected by Anthropic's git proxy, never placed in
      // the sandbox. Public repos would clone without it.
      authorization_token: env("GITHUB_TOKEN"),
      checkout: { type: "commit", sha: checkoutSha },
    },
    ...files,
  ],
});
console.log(`Session ${session.id}`);
console.log(`Watch it live: https://platform.claude.com/workspaces/${workspaceId}/sessions/${session.id}`);

// --- Run it to completion -----------------------------------------------------

// Open the stream before sending the message so no events are missed.
const stream = await client.beta.sessions.events.stream(session.id);
await client.beta.sessions.events.send(session.id, {
  events: [{ type: "user.message", content: [{ type: "text", text: message }] }],
});

let lastAgentText = "";
let stopReason = "unknown";
const deadline = setTimeout(() => {
  console.log("Session ran past the deadline, interrupting it.");
  client.beta.sessions.events
    .send(session.id, { events: [{ type: "user.interrupt" }] })
    .catch((err) => console.log(`Interrupt failed: ${err}`));
}, SESSION_DEADLINE_MS);

for await (const ev of stream) {
  if (ev.type === "agent.message") {
    const text = ev.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    if (text) {
      lastAgentText = text;
      console.log(`[agent] ${text}`);
    }
  } else if (ev.type === "agent.tool_use") {
    console.log(`[tool] ${ev.name}`);
    if (ev.evaluated_permission === "ask") {
      // Shouldn't happen with always_allow, but nobody is around to approve.
      await client.beta.sessions.events.send(session.id, {
        events: [
          {
            type: "user.tool_confirmation",
            tool_use_id: ev.id,
            result: "deny",
            deny_message: "This run is unattended; continue without this tool call.",
          },
        ],
      });
    }
  } else if (ev.type === "session.error") {
    console.log(`[session error] ${JSON.stringify(ev)}`);
  } else if (ev.type === "session.status_idle") {
    if (ev.stop_reason.type === "requires_action") continue;
    stopReason = ev.stop_reason.type;
    break;
  } else if (ev.type === "session.status_terminated") {
    stopReason = "terminated";
    break;
  }
}
clearTimeout(deadline);
console.log(`Session stopped: ${stopReason}`);

// --- Collect the review -------------------------------------------------------

async function downloadReview(): Promise<Review | undefined> {
  // Output files show up in the Files API a few seconds after the session idles.
  for (let attempt = 0; attempt < 5; attempt++) {
    const files = await client.beta.files.list({
      scope_id: session.id,
      betas: ["managed-agents-2026-04-01"],
    });
    const file = files.data.find((f) => f.filename === "review.json");
    if (file) {
      const resp = await client.beta.files.download(file.id);
      return JSON.parse(await resp.text()) as Review;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return undefined;
}

let review: Review | undefined;
try {
  review = await downloadReview();
} catch (err) {
  console.log(`Could not read review.json: ${err}`);
}
if (!review) {
  review = {
    summary: lastAgentText || `The review session ended (${stopReason}) without producing a review.`,
    comments: [],
  };
}

const finished = await client.beta.sessions.retrieve(session.id);
const cents = Number(finished.usage?.list_cost?.amount ?? 0);
// The agent rates the risk only once /code-review has run, so a review without
// one is an error report, not a review.
const footer =
  `\n\n---\n<sub>${review.risk?.level ? REVIEW_MARKER : "Review by Claude (Managed Agents) didn't finish"}` +
  ` · list cost $${(cents / 100).toFixed(2)}` +
  ` · session \`${session.id}\`</sub>`;

// --- Post it to the PR ----------------------------------------------------------

const findings = (review.comments ?? []).slice(0, MAX_INLINE_COMMENTS);
const comments = findings.map((c) => {
  const label = c.severity ? `**${c.severity}:** ` : "";
  const verdict = c.verdict
    ? `\n\n**Validation: ${VERDICT_LABELS[c.verdict] ?? c.verdict}.** ${c.verdict_reason ?? ""}`.trimEnd()
    : "";
  const multiLine = c.start_line && c.start_line < c.line;
  return {
    path: c.path,
    line: c.line,
    side: "RIGHT" as const,
    ...(multiLine ? { start_line: c.start_line, start_side: "RIGHT" as const } : {}),
    body: label + c.body + verdict,
  };
});

const tally = Object.entries(VERDICT_LABELS)
  .map(([key, label]) => [label, findings.filter((c) => c.verdict === key).length] as const)
  .filter(([, n]) => n > 0)
  .map(([label, n]) => `${n} ${label.toLowerCase()}`)
  .join(", ");
const risk = review.risk;
const riskLine = risk?.level
  ? `**Merge risk: ${RISK_LABELS[risk.level] ?? risk.level}.** ${risk.reason ?? ""}`.trimEnd() + "\n\n"
  : "";
const effort = review.review_effort;
const effortLine = effort?.level
  ? `\n\n_Reviewed at ${effort.level} effort.${effort.reason ? ` ${effort.reason}` : ""}_`
  : "";
const followUpLine = followUp ? `\n\n_Follow-up review of the commits since ${followUp.since.slice(0, 7)}._` : "";
const summary = riskLine + review.summary + (tally ? `\n\nVerdicts: ${tally}.` : "") + followUpLine + effortLine;
const listFindings = (list: typeof comments) =>
  list.map((c) => `- \`${c.path}:${c.line}\` ${c.body.replace(/\n/g, "\n  ")}`).join("\n");

// GitHub rejects the whole review (422) if any comment points outside the diff,
// so move those findings to the body up front and keep the rest inline.
const diffLines = parseDiffLines(diffText);
const inline = comments.filter((c) => isCommentable(diffLines, c.path, c.line, c.start_line));
const outside = comments.filter((c) => !inline.includes(c));
if (outside.length) console.log(`${outside.length} findings point outside the diff; posting them in the review body.`);
const outsideList = outside.length ? `\n\n**Findings outside the diff:**\n\n${listFindings(outside)}` : "";

const params = { owner, repo, pull_number: pr.number, commit_id: pr.head.sha, event: "COMMENT" as const };
let posted = inline.length;
try {
  await octokit.pulls.createReview({ ...params, body: summary + outsideList + footer, comments: inline });
} catch (err) {
  // The check above should leave nothing for GitHub to reject, but if it
  // still does, fall back to putting every finding in the review body.
  if ((err as { status?: number }).status !== 422) throw err;
  console.log(`Inline review rejected (${err}); posting findings in the review body.`);
  const listed = listFindings(comments);
  await octokit.pulls.createReview({ ...params, body: summary + (listed ? `\n\n${listed}` : "") + footer });
  posted = 0;
}
console.log(`Posted review with ${posted} inline comments.`);
