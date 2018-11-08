// tslint:disable:no-console
import { promisifyAll } from "bluebird";
import * as cluster from "cluster";
import { emptyDirSync, ensureDirSync, readFileSync } from "fs-extra";
import { join } from "path";
import redis = require("redis");
import * as perillaJudger from ".";
import { getFile } from "./file";
import * as http from "./http";
import { IFile, IJudgerConfig, ISolution, ITask, IUnsolvedTask } from "./interfaces";
import { updateSolution } from "./solution";
type messageType = "log" | "file" | "solution";
interface IRPCMessage {
    type: messageType;
    payload: any;
}

if (cluster.isMaster) {
    const config = JSON.parse(readFileSync("config.json").toString());
    const PERILLA_SERVER = config.server;
    const PERILLA_USER = config.user;
    const PERILLA_PASS = config.pass;
    const CHROOT_PATH = config.chroot;
    http.initialize(PERILLA_SERVER, PERILLA_USER, PERILLA_PASS).then(() => {
        const TMPPrefix = "tmp";
        const cpuCount = require("os").cpus().length;
        for (let i = 0; i < cpuCount; i++) {
            console.log("[MASTER] starting worker " + i);
            const TMP = join(TMPPrefix, "worker_" + i);
            ensureDirSync(TMP);
            emptyDirSync(TMP);
            const worker = cluster.fork({
                WORKER_ID: i,
                TMP_DIR: TMP,
                CHROOT_PATH,
            });
            const sendMsg = (type: messageType, payload: any) => {
                worker.send(JSON.stringify({ type, payload }));
            };
            worker.on("message", (message) => {
                try {
                    const parsed = JSON.parse(message) as IRPCMessage;
                    if (parsed.type === "log") {
                        console.log(`[#${i}] ${parsed.payload}`);
                    } else if (parsed.type === "file") {
                        console.log(`File request #${parsed.payload.requestID} @${i}`);
                        getFile(parsed.payload.id).then((file) => {
                            console.log(`File response #${parsed.payload.requestID} @${i} succeed`);
                            sendMsg("file", { success: true, file, requestID: parsed.payload.requestID });
                        }).catch((e) => {
                            console.log(`File response #${parsed.payload.requestID} @${i} failed`);
                            sendMsg("file", { success: false, requestID: parsed.payload.requestID, error: e.message });
                        });
                    } else if (parsed.type === "solution") {
                        console.log(`Solution update #${parsed.payload.requestID} @${i}`);
                        updateSolution(parsed.payload.id, parsed.payload.solution).then(() => {
                            console.log(`Solution update #${parsed.payload.requestID} @${i} succeed`);
                            sendMsg("solution", { requestID: parsed.payload.requestID, success: true });
                        }).catch((e) => {
                            console.log(`Solution update #${parsed.payload.requestID} @${i} failed`);
                            sendMsg("solution", { requestID: parsed.payload.requestID, success: false, error: e.message });
                        });
                    }
                } catch (e) {
                    console.log("Failed process message: " + message);
                }
            });
        }
    });
} else {
    const sendMsg = (type: messageType, payload: any) => {
        process.send(JSON.stringify({ type, payload }));
    };
    const Resolvers: any = {};
    let RequestCount = 0;
    const resolveFile = (id: string) => {
        return new Promise<IFile>((resolve, reject) => {
            Resolvers[RequestCount] = { resolve, reject };
            sendMsg("file", { id, requestID: RequestCount });
            RequestCount++;
        });
    };
    const callback = (solution: ISolution, id: string) => {
        return new Promise<void>((resolve, reject) => {
            Resolvers[RequestCount] = { resolve, reject };
            sendMsg("solution", { id, solution, requestID: RequestCount });
            RequestCount++;
        });
    };
    process.on("message", (message) => {
        const parsed = JSON.parse(message) as IRPCMessage;
        if (parsed.payload.success) {
            if (parsed.type === "file") {
                Resolvers[parsed.payload.requestID].resolve(parsed.payload.file);
            } else if (parsed.type === "solution") {
                Resolvers[parsed.payload.requestID].resolve();
            }
        } else {
            Resolvers[parsed.payload.requestID].reject(parsed.payload.error);
        }
        delete Resolvers[parsed.payload.requestID];
    });

    console.log = (message: any) => {
        sendMsg("log", message);
    };
    console.log("started");

    promisifyAll(redis);
    const instance: any = redis.createClient();

    const config: IJudgerConfig = {
        cgroup: "JUDGE" + process.env.WORKER_ID,  // Cgroup, for sandbox
        chroot: process.env.CHROOT_PATH,
    };

    (async () => {
        await perillaJudger.initialize(config);
        const channels = perillaJudger.getChannels();
        let channelID = 0;
        while (true) {
            const raw = (await instance.brpopAsync(channels[channelID], 30))[1];
            if (raw) {
                const parsed = JSON.parse(raw) as IUnsolvedTask;
                const problemFiles = [];
                const solutionFiles = [];
                for (const id of parsed.problemFiles) {
                    problemFiles.push(await resolveFile(id));
                }
                for (const id of parsed.solutionFiles) {
                    solutionFiles.push(await resolveFile(id));
                }
                const task: ITask = {
                    solutionID: parsed.solutionID,
                    solutionFiles,
                    problemFiles,
                    data: parsed.data,
                };
                await perillaJudger.judge(task, channels[channelID], callback);
            }
            channelID = (channelID === channels.length - 1) ? 0 : channelID + 1;
        }
    })();
}