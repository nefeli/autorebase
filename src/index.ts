import { createApplicationFunction } from "./app";
import { Application } from "probot";

const nopHandler = () => Promise.resolve();

module.exports = (app : Application) => {
  const af = createApplicationFunction({
    handleAction: nopHandler,
    handleEvent: nopHandler,
    label: "autorebase",
  });
  af(app);
}
