// Subprocess fixture: claim a job and wait to be SIGKILLed, without acknowledgement or model calls.
import { Registry } from "../core/registry";
import { DISCOVERY_QUEUE, jobs } from "../core/jobs";
const reg = new Registry(process.env.CREAMA_SAFETY_TEST_URL, { schema: process.env.CREAMA_QUEUE_TEST_SCHEMA! });
const boss = await jobs(reg);
const [job] = await boss.fetch(DISCOVERY_QUEUE, { includeMetadata: true });
process.send?.(job);
setInterval(() => {}, 1000);
