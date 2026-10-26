# claude-review

A pull request reviewer built on [Claude Managed Agents](https://docs.claude.com/en/docs/agents/managed-agents),
packaged as a GitHub Action. It bills to an Anthropic API key, so it runs on Console API credits.

## How it works

```
PR opened ──▶ GitHub Action (this repo) ──▶ Managed Agents session ──▶ review.json ──▶ PR review
              fetches diff, starts session   clones repo, reads code,     downloaded     posted with
                                             runs tests, writes findings  by the Action  GITHUB_TOKEN
```

Managed Agents has no inbound triggers, so a small relay has to start each session. A GitHub Action
is that relay: no server to host, and it gets a GitHub token for free.

1. The workflow fires on `pull_request_target` and runs `src/review.ts`.
2. The script fetches the PR diff, uploads it, and creates a session on the `pr-reviewer` agent with
   the repo mounted at the PR's merge base as a `github_repository` resource. Each session has a hard
   spend cap (`budget-usd`, default $7.50), and Claude Code's run, which bills to the vault key, gets the
   same cap through `--max-budget-usd`.
3. In its sandbox, the agent applies the diff on top of the merge base, installs Claude Code, and
   runs the bundled `/code-review` at low, medium, or high effort, which it picks from a quick read
   of the diff by size, complexity, and potential impact. It then checks each finding against the code
   (valid, unlikely, not worth fixing, or incorrect, with the reason), rates the change risk (low,
   medium, or high, by what the change could break), and decides whether the PR is good to merge
   (yes, after fixes, or no, from the valid findings). It writes all of that to
   `/mnt/session/outputs/review.json`, one inline comment per finding tied to a changed line.
4. The script downloads that file and posts one `COMMENT` review: the merge call, the change risk
   and a count of verdicts in the summary, and each finding's verdict in its inline comment. It never
   approves or requests changes.

When the PR has been reviewed before, the next review is a follow-up: the agent reviews only the
commits since its last review, with the whole PR in the working tree for context, reports which
earlier findings are fixed or still open, and updates its risk rating and merge call. If the PR was rebased or the
base branch was merged in since, the new commits can't be separated cleanly, so it reviews the
whole PR again, still with the last review in hand.

The agent definition (model, system prompt, tools) lives in [`src/agent.ts`](src/agent.ts).
Change it and push to `main`; the **Set up reviewer agent** workflow publishes a new agent version
and every later review uses it.

## Setup

Auth uses [Workload Identity Federation](https://platform.claude.com/docs/en/manage-claude/wif-providers/github-actions):
each job signs in to Anthropic with its own GitHub identity token, so no repo holds an API key.
The federation rule, organization, service account, and workspace IDs are defaults in
[`action.yml`](action.yml). They are not secret.

1. **Give Claude Code an API key.** Claude Code runs inside the sandbox and needs its own key. In
   the Console, create a vault named `pr-reviewer` with one environment-variable credential:
   secret name `ANTHROPIC_API_KEY`, the key as its value, and allowed host `api.anthropic.com`.
   The key never enters the sandbox; Anthropic swaps it in on requests to that host.
2. **Create the agent.** Actions tab → **Set up reviewer agent** → Run workflow.
3. **Turn it on in a repo.** Copy [`examples/claude-review.yml`](examples/claude-review.yml) to
   `.github/workflows/claude-review.yml` there. It takes effect once it's on the default branch.
   The repo must match a federation rule in the Console
   ([Workload identity](https://platform.claude.com/settings/workload-identity-federation)).
   A repo outside those rules can pass its own `anthropic-federation-rule-id`, or an
   `anthropic-api-key` from a secret instead.

Reviews post as the identity of `github-token`, github-actions by default. A github-actions review
doesn't trigger other workflows, so `pull_request_review` workflows won't run on it.

**Verify Anthropic auth** makes one API call with the federation rule, to check it works.

## When it runs

- Automatically on opened, reopened, and ready-for-review PRs whose author is the owner, an org
  member, or a collaborator. Drafts are skipped.
- On any PR when someone adds the `claude-review` label. Remove and re-add it for a fresh review.

When the review's call is "After fixes" or "No", the job fails, so the PR shows a failing check on
the reviewed commit. Pushes don't re-run the review, so a new commit has no review check until
someone re-adds the label.

## Options

```yaml
- uses: sddamico/claude-review@main
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    budget-usd: "10"                       # per-session cap, default 7.5
    extra-instructions: "We target iOS 17+; flag any API that needs a newer OS."
    anthropic-workspace-id: wrkspc_...      # only for the live session link in the log
```

## Security notes

- The PR's code is never checked out or run on the Actions runner, which is what makes
  `pull_request_target` safe here. It only runs inside Anthropic's sandbox.
- The sandbox can't read any secret: the GitHub token is injected by Anthropic's git proxy and the
  Claude Code key is swapped in at egress. But anything running in the sandbox, including code a
  PR adds, can *use* the key on `api.anthropic.com`. Claude Code loads only user settings, so a PR
  can't add hooks or MCP servers, but for defense in depth give the vault key its own Console
  workspace with a low spend limit, separate from the workspace that holds the reviewer agent.
  Network egress is limited to package registries and `api.anthropic.com`.
- PR text is treated as data, but a malicious PR could still steer what the review says. Reviews are
  `COMMENT` only, so the worst case is a misleading comment.
