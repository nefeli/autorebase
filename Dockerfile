FROM node:10

RUN apt-get update && apt-get install -y yarn

ENV PATH=$PATH:/app/node_modules/.bin
WORKDIR /app
COPY yarn.lock .
COPY package.json .
RUN yarn install

COPY . .
RUN tsc

ENTRYPOINT ["probot", "receive"]
CMD ["/app/src/index.js"]
