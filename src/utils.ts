import * as assert from "assert";

import * as Octokit from "@octokit/rest";
import {
  PullRequestNumber,
  Ref,
  RepoName,
  RepoOwner,
  Sha,
} from "shared-github-internals/lib/git";

// tslint:disable-next-line:no-var-requires (otherwise we get the error TS2497).
const promiseRetry = require("promise-retry");

type Debug = (...args: any[]) => void;

type LabelName = string;

/**
 * See https://developer.github.com/v4/enum/mergestatestatus/
 */
type MergeableState =
  | "behind"
  | "blocked"
  | "clean"
  | "dirty"
  | "unknown"
  | "unstable";

type PullRequestInfo = {
  base: Ref;
  head: Ref;
  labeledAndOpened: boolean;
  labeledAndOpenedAndRebaseable: boolean;
  mergeableState: MergeableState;
  merged: boolean;
  pullRequestNumber: PullRequestNumber;
  sha: Sha;
};

const sleep = (milliseconds: number) =>
  new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });

const getPullRequestInfo = ({
  debug,
  label,
  pullRequest: {
    base: { ref: base },
    closed_at: closedAt,
    head: { ref: head, sha },
    labels,
    mergeable,
    mergeable_state: mergeableState,
    merged,
    number: pullRequestNumber,
  },
}: {
  debug: Debug;
  label: LabelName;
  pullRequest: Octokit.PullsGetResponse;
}): PullRequestInfo => {
  const labelNames = labels.map(({ name }) => name);
  debug("pull request info", {
    base,
    closedAt,
    head,
    labelNames,
    mergeable,
    mergeableState,
    merged,
    pullRequestNumber,
    sha,
  });

  return {
    base,
    head,
    labeledAndOpened:
      labels.map(({ name }) => name).includes(label) &&
      closedAt === null,
    labeledAndOpenedAndRebaseable:
      labels.map(({ name }) => name).includes(label) &&
      closedAt === null &&
      // We used to look at the `rebaseable` flag sent by GitHub
      // but it's sometimes `false` even though the PR is actually rebaseable.
      mergeable,
    mergeableState: mergeableState as MergeableState,
    merged,
    pullRequestNumber,
    sha,
  };
};

const isMergeableStateKnown = ({
  closed_at: closedAt,
  mergeable_state: mergeableState,
}: Octokit.PullsGetResponse) =>
  closedAt !== null || mergeableState !== "unknown";

const checkKnownMergeableState = async ({
  debug,
  octokit,
  owner,
  pullRequestNumber,
  repo,
}: {
  debug: Debug;
  octokit: Octokit;
  owner: RepoOwner;
  pullRequestNumber: PullRequestNumber;
  repo: RepoName;
}): Promise<Octokit.PullsGetResponse> => {
  debug("fetching mergeable state", { pullRequestNumber });
  const { data: pullRequest } = await octokit.pulls.get({
    number: pullRequestNumber,
    owner,
    repo,
  });
  const { closed_at: closedAt, mergeable_state: mergeableState } = pullRequest;
  debug("mergeable state", { closedAt, mergeableState, pullRequestNumber });
  assert(isMergeableStateKnown(pullRequest));
  return pullRequest;
};

const waitForKnownMergeableState = ({
  debug,
  octokit,
  owner,
  pullRequestNumber,
  repo,
}: {
  debug: Debug;
  octokit: Octokit;
  owner: RepoOwner;
  pullRequestNumber: PullRequestNumber;
  repo: RepoName;
}): Promise<Octokit.PullsGetResponse> =>
  promiseRetry(
    async (retry: (error: any) => void) => {
      try {
        return await checkKnownMergeableState({
          debug,
          octokit,
          owner,
          pullRequestNumber,
          repo,
        });
      } catch (error) {
        debug("retrying to know mergeable state", { pullRequestNumber });
        return retry(error);
      }
    },
    { minTimeout: 500 },
  );

const getPullRequestInfoWithKnownMergeableState = async ({
  debug,
  label,
  octokit,
  owner,
  pullRequestNumber,
  repo,
}: {
  debug: Debug;
  label: LabelName;
  octokit: Octokit;
  owner: RepoOwner;
  pullRequestNumber: PullRequestNumber;
  repo: RepoName;
}) => {
  // Sometimes, a webhook is sent with `mergeable_state: 'clean'` when the
  // pull request actual mergeable state is `behind`.
  // Or with `mergeable_state: 'unstable'` when it's actually `behind` too.
  // Making a request to the GitHub API to retrieve the pull request details
  // will return the actual mergeable state.
  // Thus, we don't try to see if the pull request passed as an argument
  // has already a known mergeable state, we always ask the GitHub API for it.
  const pullRequestWithKnownMergeableState = await waitForKnownMergeableState({
    debug,
    octokit,
    owner,
    pullRequestNumber,
    repo,
  });
  return getPullRequestInfo({
    debug,
    label,
    pullRequest: pullRequestWithKnownMergeableState,
  });
};

const getPullRequestNumbers = (searchResults: any): PullRequestNumber[] =>
  searchResults.items.map((item: any) => item.number);

const findOldestPullRequest = async ({
  debug,
  extraSearchQualifiers,
  label,
  octokit,
  owner,
  predicate,
  repo,
}: {
  debug: Debug;
  extraSearchQualifiers: string;
  label: LabelName;
  octokit: Octokit;
  owner: RepoOwner;
  predicate: (pullRequestInfo: PullRequestInfo) => boolean;
  repo: RepoName;
}): Promise<PullRequestInfo | null> => {
  const query = `is:pr is:open label:"${label}" repo:${owner}/${repo} ${extraSearchQualifiers}`;
  debug("searching oldest matching pull request", { query });

  // Use the search endpoint to be able to filter on labels.
  const options = octokit.search.issuesAndPullRequests.endpoint.merge({
    order: "asc",
    q: query,
    sort: "created",
  });

  // Waiting a bit before to let GitHub make its data consistent.
  await sleep(1000);
  const searchResults = await octokit.paginate(options);
  const pullRequestNumbers = Array.prototype.concat(
    ...searchResults.map(getPullRequestNumbers),
  );
  debug({ pullRequestNumbers });
  const initialPromise = Promise.resolve(null);
  return pullRequestNumbers.reduce(
    async (
      promise: Promise<PullRequestInfo | null>,
      pullRequestNumber: PullRequestNumber,
    ) => {
      const result = await promise;
      if (result) {
        return result;
      }
      debug({ pullRequestNumber });
      const pullRequest = await getPullRequestInfoWithKnownMergeableState({
        debug,
        label,
        octokit,
        owner,
        pullRequestNumber,
        repo,
      });
      const matchingPredicate = predicate(pullRequest);
      debug({ matchingPredicate, pullRequest });
      return matchingPredicate ? pullRequest : null;
    },
    initialPromise,
  );
};

const findAutorebaseablePullRequestMatchingSha = ({
  debug,
  label,
  octokit,
  owner,
  repo,
  sha,
}: {
  debug: Debug;
  label: LabelName;
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
  sha: Sha;
}) =>
  findOldestPullRequest({
    debug,
    extraSearchQualifiers: sha,
    label,
    octokit,
    owner,
    predicate: ({ labeledAndOpenedAndRebaseable, sha: pullRequestSha }) =>
      labeledAndOpenedAndRebaseable && pullRequestSha === sha,
    repo,
  });

// See the FAQ in README.md for why we do that.
const withLabelLock = async ({
  action,
  debug,
  label,
  octokit,
  owner,
  pullRequestNumber,
  repo,
}: {
  action: () => Promise<void>;
  debug: Debug;
  label: LabelName;
  octokit: Octokit;
  owner: RepoOwner;
  pullRequestNumber: PullRequestNumber;
  repo: RepoName;
}) => {
  try {
    debug("acquiring lock", pullRequestNumber);
    await octokit.issues.removeLabel({
      name: label,
      number: pullRequestNumber,
      owner,
      repo,
    });
  } catch (error) {
    debug("lock already acquired by another process", pullRequestNumber);
    return false;
  }

  debug("lock acquired", pullRequestNumber);
  await action();
  debug("releasing lock", pullRequestNumber);
  await octokit.issues.addLabels({
    labels: [label],
    number: pullRequestNumber,
    owner,
    repo,
  });
  debug("lock released", pullRequestNumber);
  return true;
};

const maybeGiveUp = async ({
  debug,
  label,
  octokit,
  owner,
  pullRequestNumber,
  repo,
}: {
  debug: Debug;
  label: LabelName;
  octokit: Octokit;
  owner: RepoOwner;
  pullRequestNumber: PullRequestNumber;
  repo: RepoName;
}) => {
  const pullRequest = await getPullRequestInfoWithKnownMergeableState({
    debug,
    label,
    octokit,
    owner,
    pullRequestNumber,
    repo,
    });
  debug("pull request info for maybeGiveUp", pullRequest);

  var gu = (err: string) => {
    giveUp({
      debug,
      label,
      octokit,
      owner,
      pullRequestNumber,
      repo,
      err
    });
  };

  if (!pullRequest.labeledAndOpened) {
    return;
  }

  if (pullRequest.mergeableState === "dirty") {
    await gu("Conflicting files");
    return;
  }

  if (pullRequest.mergeableState === "blocked") {
    // are we blocked by a failed jenkins run?
    const status = await octokit.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref: pullRequest.sha,
    });
    debug("status check for blocked PR", status);
    if (status.data.state === "failure") {
      await gu("Blocked by jenkins");
      return;
    } else if (status.data.state === "pending") {
      debug("jenkins still pending... letting jenkins finish");
      return;
    }

    // need to check if blocked by missing or negative reviews
    const reviews = await octokit.pulls.listReviews({
      owner,
      repo,
      number: pullRequestNumber,
    });
    debug("review check for blocked PR", reviews);
    if (reviews.data.length === 0) {
      await gu("Wait for reviews");
      return;
    } else {
      var passing = false;
      for (var i = 0; i < reviews.data.length; i++) {
        if (reviews.data[i].state === "CHANGES_REQUESTED") {
          await gu("Address reviewer comments");
          return;
        }
        if (reviews.data[i].state === "APPROVED") {
          passing = true;
        }
      }
      if (!passing) { // probably a dismissed review
        await gu("Wait for reviews");
        return;
      }
    }
  }
};

const giveUp = async ({
  debug,
  label,
  octokit,
  owner,
  pullRequestNumber,
  repo,
  err,
}: {
  debug: Debug;
  label: LabelName;
  octokit: Octokit;
  owner: RepoOwner;
  pullRequestNumber: PullRequestNumber;
  repo: RepoName;
  err: string;
}) => {
  debug("giving up... writing comment on PR: ", err);
  await octokit.issues.createComment({
    owner: owner,
    repo: repo,
    number: pullRequestNumber,
    body: ['<h2><p align="center">:construction: :construction_worker: :fire: Giving up on autorebase, please investigate: :fire: :construction_worker: :construction:</p>',
    "",
    '<p align="center">:rotating_light: ' + err + ' :rotating_light:</p></h2>',
    "",
    ].join("\n"),
  });
  try {
    debug("removing label", pullRequestNumber);
    await octokit.issues.removeLabel({
      name: label,
      number: pullRequestNumber,
      owner,
      repo,
    });
  } catch (error) {
    debug("label already acquired by another process", pullRequestNumber);
  }
};

export {
  Debug,
  findAutorebaseablePullRequestMatchingSha,
  findOldestPullRequest,
  getPullRequestInfoWithKnownMergeableState,
  LabelName,
  PullRequestInfo,
  sleep,
  waitForKnownMergeableState,
  withLabelLock,
  maybeGiveUp,
  giveUp,
};
