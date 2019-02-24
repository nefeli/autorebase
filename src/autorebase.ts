import * as Octokit from "@octokit/rest";
import * as createDebug from "debug";
import { needAutosquashing, rebasePullRequest } from "github-rebase";
import {
  deleteRef,
  PullRequestNumber,
  Ref,
  RepoName,
  RepoOwner,
  Sha,
} from "shared-github-internals/lib/git";

import {
  Debug,
  findAutorebaseablePullRequestMatchingSha,
  findOldestPullRequest,
  getPullRequestInfoWithKnownMergeableState,
  LabelName,
  PullRequestInfo,
  withLabelLock,
} from "./utils";

/**
 * When Autorebase tries to rebase a pull request that doesn't have the label anymore.
 */
type AbortAction = { pullRequestNumber: PullRequestNumber; type: "abort" };

type MergeAction = { pullRequestNumber: PullRequestNumber; type: "merge" };

type RebaseAction = { pullRequestNumber: PullRequestNumber; type: "rebase" };

type FailedAction = { error: Error; type: "failed" };

type NopAction = { type: "nop" };

type Action =
  | AbortAction
  | FailedAction
  | MergeAction
  | RebaseAction
  | NopAction;

/**
 * See https://developer.github.com/webhooks/#events
 */
type Event = { id: string } & (
  | {
      name: "check_run";
      payload: {
        check_run: {
          head_sha: Sha;
        };
      };
    }
  | {
      name: "pull_request";
      payload:
        | {
            action: "closed" | "opened" | "synchronize";
            pull_request: Octokit.PullsGetResponse;
          }
        | {
            action: "labeled";
            label: { name: LabelName };
            pull_request: Octokit.PullsGetResponse;
          };
    }
  | {
      name: "pull_request_review";
      payload: {
        action: "dismissed" | "edited" | "submitted";
        pull_request: { number: PullRequestNumber };
      };
    }
  | {
      name: "status";
      payload: {
        sha: Sha;
      };
    });

const globalDebug = createDebug("autorebase");

const merge = async ({
  debug,
  head,
  octokit,
  owner,
  pullRequestNumber,
  repo,
}: {
  debug: Debug;
  head: Ref;
  octokit: Octokit;
  owner: RepoOwner;
  pullRequestNumber: PullRequestNumber;
  repo: RepoName;
}): Promise<MergeAction> => {
  debug("merging", pullRequestNumber);
  await octokit.pulls.merge({
    merge_method: "rebase",
    number: pullRequestNumber,
    owner,
    repo,
  });
  debug("merged", pullRequestNumber);
  debug("deleting reference", head);
  await deleteRef({ octokit, owner, ref: head, repo });
  debug("reference deleted", head);
  return {
    pullRequestNumber,
    type: "merge",
  };
};

const rebase = async ({
  debug,
  label,
  octokit,
  owner,
  pullRequestNumber,
  repo,
}: {
  debug: Debug;
  label: LabelName;
  pullRequestNumber: PullRequestNumber;
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
}): Promise<AbortAction | RebaseAction> => {
  debug("rebasing", pullRequestNumber);

  try {
    const rebased = await withLabelLock({
      async action() {
        await rebasePullRequest({
          octokit,
          owner,
          pullRequestNumber,
          repo,
        });
      },
      debug,
      label,
      octokit,
      owner,
      pullRequestNumber,
      repo,
    });

    if (!rebased) {
      debug("other process already rebasing, aborting", pullRequestNumber);
      return { pullRequestNumber, type: "abort" };
    }

    debug("rebased", pullRequestNumber);
    return { pullRequestNumber, type: "rebase" };
  } catch (error) {
    const message = "rebase failed";
    debug(message, error);
    await octokit.issues.createComment({
      body: [`The rebase failed:`, "", "```", error.message, "```"].join("\n"),
      number: pullRequestNumber,
      owner,
      repo,
    });
    throw new Error(message);
  }
};

const findAndRebasePullRequestOnSameBase = async ({
  base,
  debug,
  label,
  octokit,
  owner,
  repo,
}: {
  base: Ref;
  debug: Debug;
  label: LabelName;
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
}): Promise<AbortAction | RebaseAction | NopAction> => {
  debug("searching for pull request to rebase on same base", base);
  const pullRequest = await findOldestPullRequest({
    debug,
    extraSearchQualifiers: `base:${base}`,
    label,
    octokit,
    owner,
    predicate: ({ mergeableState }) => mergeableState === "behind",
    repo,
  });
  debug("pull request to rebase on same base", pullRequest);
  return pullRequest
    ? rebase({
        debug,
        label,
        octokit,
        owner,
        pullRequestNumber: pullRequest.pullRequestNumber,
        repo,
      })
    : { type: "nop" };
};

const autorebasePullRequest = async ({
  debug,
  forceRebase,
  label,
  octokit,
  owner,
  pullRequest,
  repo,
}: {
  debug: Debug;
  forceRebase: boolean;
  label: LabelName;
  octokit: Octokit;
  owner: RepoOwner;
  pullRequest: PullRequestInfo;
  repo: RepoName;
}): Promise<Action> => {
  const shouldBeAutosquashed = await needAutosquashing({
    octokit,
    owner,
    pullRequestNumber: pullRequest.pullRequestNumber,
    repo,
  });
  debug("autorebasing pull request", {
    forceRebase,
    pullRequest,
    shouldBeAutosquashed,
  });
  const shouldBeRebased =
    forceRebase ||
    shouldBeAutosquashed ||
    pullRequest.mergeableState === "behind";
  if (shouldBeRebased) {
    return rebase({
      debug,
      label,
      octokit,
      owner,
      pullRequestNumber: pullRequest.pullRequestNumber,
      repo,
    });
  }
  if (pullRequest.mergeableState === "clean") {
    return merge({
      debug,
      head: pullRequest.head,
      octokit,
      owner,
      pullRequestNumber: pullRequest.pullRequestNumber,
      repo,
    });
  }
  return { type: "nop" };
};

const autorebase = async ({
  event,
  forceRebase,
  label,
  octokit,
  owner,
  repo,
}: {
  event: Event;
  forceRebase: boolean;
  label: LabelName;
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
}): Promise<Action> => {
  const debug = globalDebug.extend(event.id);
  debug("received event", { event, label });

  if (event.name === "check_run" || event.name === "status") {
    const sha: Sha =
      event.name === "check_run"
        ? event.payload.check_run.head_sha
        : event.payload.sha;
    debug("handling check_run or status event", { sha });
    const pullRequest = await findAutorebaseablePullRequestMatchingSha({
      debug,
      label,
      octokit,
      owner,
      repo,
      sha,
    });

    if (pullRequest) {
      debug("autorebaseable pull request matching sha", pullRequest);
      if (pullRequest.mergeableState === "clean") {
        return merge({
          debug,
          head: pullRequest.head,
          octokit,
          owner,
          pullRequestNumber: pullRequest.pullRequestNumber,
          repo,
        });
      } else if (pullRequest.mergeableState === "blocked") {
        // Happens when an autorebaseable pull request gets blocked by an error status.
        // Assuming that the autorebase label was added on a pull request behind but with green statuses,
        // it means that the act of rebasing the pull request made it unmergeable.
        // Some manual intervention will have to be done on the pull request to unblock it.
        // In the meantime, in order not to be stuck,
        // Autorebase will try to rebase another pull request based on the same branch.
        return findAndRebasePullRequestOnSameBase({
          base: pullRequest.base,
          debug,
          label,
          octokit,
          owner,
          repo,
        });
      }
    }
  } else {
    const {
      name,
      payload: {
        action,
        pull_request: { number: pullRequestNumber },
      },
    } = event;
    const { closed_at: closedAt, mergeable, merged } =
      event.name === "pull_request"
        ? event.payload.pull_request
        : { closed_at: null, mergeable: null, merged: null };
    const isAutorebaseSamePullRequestEvent =
      event.name === "pull_request" &&
      (action === "opened" ||
        action === "synchronize" ||
        (event.payload.action === "labeled" &&
          event.payload.label.name === label)) &&
      (mergeable || forceRebase) &&
      closedAt === null;
    const isRebasePullRequestOnSameBaseEvent =
      name === "pull_request" && action === "closed" && merged;
    const isMergeEvent = name === "pull_request_review";

    debug({
      action,
      closedAt,
      isAutorebaseSamePullRequestEvent,
      isMergeEvent,
      isRebasePullRequestOnSameBaseEvent,
      mergeable,
      merged,
      name,
    });

    if (
      isAutorebaseSamePullRequestEvent ||
      isRebasePullRequestOnSameBaseEvent ||
      isMergeEvent
    ) {
      const pullRequest = await getPullRequestInfoWithKnownMergeableState({
        debug,
        label,
        octokit,
        owner,
        pullRequestNumber,
        repo,
      });
      debug("pull request with known mergeable state", pullRequest);

      if (isAutorebaseSamePullRequestEvent) {
        if (forceRebase || pullRequest.labeledAndOpenedAndRebaseable) {
          if (!pullRequest.labeledAndOpenedAndRebaseable) {
            debug("force rebasing");
          }
          return autorebasePullRequest({
            debug,
            forceRebase,
            label,
            octokit,
            owner,
            pullRequest,
            repo,
          });
        }
      }

      if (isRebasePullRequestOnSameBaseEvent) {
        return findAndRebasePullRequestOnSameBase({
          base: pullRequest.base,
          debug,
          label,
          octokit,
          owner,
          repo,
        });
      }

      if (pullRequest.labeledAndOpenedAndRebaseable) {
        return merge({
          debug,
          head: pullRequest.head,
          octokit,
          owner,
          pullRequestNumber,
          repo,
        });
      }
    }
  }

  debug("nop");
  return { type: "nop" };
};

export { Action, autorebase, Event };
