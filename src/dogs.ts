import * as Octokit from "@octokit/rest";
import {
  PullRequestNumber,
  RepoName,
  RepoOwner,
} from "shared-github-internals/lib/git";

type Debug = (...args: any[]) => void;
const { get } = require('node-superfetch');

const getDog = async () => {
  // get a dog pic
  var pup = "";
  var res = await get('https://dog.ceo/api/breeds/image/random');
  if (res.ok) {
    pup = res.body.message;
  } else {
    console.error(`Couldn't fetch pup (lol): ${res.error}`);
  }
  return pup;
};

const commentDog = async ({
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
}) => {
  var pup = await getDog()
  await octokit.issues.createComment({
    owner: owner,
    repo: repo,
    number: pullRequestNumber,
    body: '<p align="center"><img src="' + pup + '"></p>'
  });
};

export {
  commentDog,
};