import { initDb, getPrimaryMailbox } from "./db.js";
import { syncMailbox } from "./sync.js";

await initDb();
const mailbox = await getPrimaryMailbox();

if (!mailbox) {
  console.log("No Gmail mailbox is connected yet. Visit the dashboard and connect Gmail first.");
  process.exit(0);
}

const result = await syncMailbox(mailbox);
console.log(result.summary);
process.exit(0);
