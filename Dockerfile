FROM node:10

RUN apt-get update && apt-get install -y yarn

ENV PATH=$PATH:/app/node_modules/.bin
WORKDIR /app
COPY yarn.lock .
COPY package.json .
RUN yarn install

COPY ./github-rebase/yarn.lock ./github-rebase/
COPY ./github-rebase/package.json ./github-rebase/
RUN cd github-rebase && yarn install

COPY ./github-rebase/shared-github-internals/yarn.lock ./github-rebase/shared-github-internals/
COPY ./github-rebase/shared-github-internals/package.json ./github-rebase/shared-github-internals/
RUN cd github-rebase/shared-github-internals && yarn install

COPY . .
RUN tsc

ENTRYPOINT ["probot", "run"]
CMD ["/app/src/index.js"]
