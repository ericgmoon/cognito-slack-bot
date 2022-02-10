import {Context} from "@slack/bolt";
import {WebClient} from "@slack/web-api/dist/WebClient"
import {credential, firestore} from "firebase-admin";
import applicationDefault = credential.applicationDefault;
import {GenericMessageEvent} from "@slack/bolt/dist/types/events/message-events";
import Transaction = firestore.Transaction;
import DocumentSnapshot = firestore.DocumentSnapshot;
import DocumentReference = firestore.DocumentReference;

const {App} = require('@slack/bolt');

const admin = require("firebase-admin");
const {getFirestore} = require('firebase-admin/firestore');
const config = require("./config.json");


admin.initializeApp({
    credential: applicationDefault(),
});

const db = getFirestore();

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN
});


const replacementVars: string[] = ["deltaKarma", "totalKarma", "user", "maxKarma", "minKarma", "botUser"]

function replaceMessageVars(message: string, args: { [key: string]: any }): string {
    for (const replacementVar of replacementVars) {
        if (args[replacementVar]) {
            if (replacementVar.endsWith("User") || replacementVar.endsWith("user")) {
                message = message.replace(`\${${replacementVar}}`, `<@${args[replacementVar].toString()}>`)
            } else {
                message = message.replace(`\${${replacementVar}}`, args[replacementVar].toString());
            }

        }
    }
    return message.replace(new RegExp("$[\\w+]", "g"), "\\w+");
}


//this is harder than i thought whoops
function extractMessageVars(message: string, pattern: string) {
    const result: {[key:string]: string} = {};
    const extractions = new RegExp("\\$\\[\\w+]", "g");
    const extractionsCopy = new RegExp("\\$\\[\\w+]");
    let match;
    while (match = extractions.exec(pattern)) {
        let pullPattern = pattern.slice(0, match.index).replace(extractionsCopy, "[\\w@<>]+");
        let value = message.replace(new RegExp(pullPattern), "").match("^[\\w@<>]+");
        const varName = match[0].slice(2, match[0].length - 1);
        if (varName.endsWith("user") || varName.endsWith("User")) {
            result[varName] = value![0].slice(2, value![0].length - 1);
        } else {
            result[varName] = value![0];
        }

    }
    return result;
}

async function postToChannel(client: WebClient, channel: string, thread: string, text: string) {
    await client.chat.postMessage({
        channel: channel,
        thread_ts: thread,
        text: text
    });
}

async function applyKarmaChange(team: string, deltaKarma: number, author: string, target: string, botUser: string, client: WebClient, channel: string, thread: string) {
    let postPromise: Promise<any> | null = null

    const teamDoc: DocumentReference = db.collection("servers").doc(team);
    const karmaDoc: DocumentReference = teamDoc.collection("karma").doc(target);


    await db.runTransaction(async (t: Transaction) => {
        const doc: DocumentSnapshot = await t.get(karmaDoc);
        const staff: string[] = (await t.get(teamDoc)).get("staff");
        // student -/> student
        // student -> staff
        // staff -> staff
        // staff -> student

        let currentKarma = 0;

        if (!doc.exists) {
            currentKarma = 0;
            t.set(karmaDoc, {"value": 0});
        } else {
            currentKarma = doc.get("value");
        }

        if ((!(staff.includes(author)) && !(staff.includes(target))) || target == author) {
            postPromise = postToChannel(client, channel, thread, replaceMessageVars(config.message_cant_karma, {
                deltaKarma: deltaKarma,
                totalKarma: currentKarma,
                user: target,
                botUser: botUser,
                minKarma: config.min_karma,
                max_karma: config.max_karma
            }));
            return;
        }

        if (currentKarma + deltaKarma > config.max_karma) {
            console.log("giving too much karma");
            postPromise = postToChannel(client, channel, thread, replaceMessageVars(config.message_exceed_max, {
                deltaKarma: deltaKarma,
                totalKarma: currentKarma,
                user: target,
                botUser: botUser,
                minKarma: config.min_karma,
                maxKarma: config.max_karma
            }));
        } else if (currentKarma + deltaKarma < config.min_karma) {
            console.log("taking too much karma");
            postPromise = postToChannel(client, channel, thread, replaceMessageVars(config.message_exceed_min, {
                deltaKarma: deltaKarma,
                totalKarma: currentKarma,
                user: target,
                botUser: botUser,
                minKarma: config.min_karma,
                maxKarma: config.max_karma
            }));
        } else {
            console.log("applying karma");
            t.update(karmaDoc, "value", currentKarma + deltaKarma);
            postPromise = postToChannel(client, channel, thread, replaceMessageVars(deltaKarma > 0 ? config.message_give : config.message_take, {
                deltaKarma: deltaKarma,
                totalKarma: currentKarma + deltaKarma,
                user: target,
                botUser: botUser,
                minKarma: config.min_karma,
                maxKarma: config.max_karma
            }));
        }
    });
    await postPromise;
}

async function promote_owners(client: WebClient, team_id: string) {
    const owners = []
    for (const member of (await client.users.list({team_id: team_id})).members!) {
        if (member.is_owner) {
            owners.push(member.id);
        }
    }

    await db.collection("servers").doc(team_id).set({"staff": owners});
}

async function promote(client: WebClient, user: string, team_id: string) {
    await db.collection("servers").doc(team_id).update({"staff": firestore.FieldValue.arrayUnion(user)});
}

async function demote(client: WebClient, user: string, team_id: string) {
    await db.collection("servers").doc(team_id).update({"staff": firestore.FieldValue.arrayRemove(user)});
}

function command_match(text: string, command_literal: string, botUser: string): boolean {
    const matches = text.match(new RegExp(replaceMessageVars(command_literal, {
        "botUser": botUser
    }), "g"));
    return matches != null && matches.length != 0;
}


app.event('message', async ({
                                event, context, client, say
                            }: {
    event: GenericMessageEvent, context: Context, client: WebClient, say: (arg0: string) => void
}) => {
    if (event.text == undefined) {
        return;
    }

    console.log(event.text);

    if (command_match(event.text, config.command_autopromote, context.botUserId!)) {
        if (!(await client.users.info({user: event.user})).user?.is_owner) {
            console.log("not owner");
            return;
        }
        await promote_owners(client, event.team!);
        await client.reactions.add({channel: event.channel, name: "thumbsup", timestamp: event.ts})
        return;
    } else if (command_match(event.text, config.command_promote, context.botUserId!)) {
        if (!(await client.users.info({user: event.user})).user?.is_owner) {
            console.log("not owner");
            return;
        }
        const vars = extractMessageVars(event.text, config.command_promote);
        await promote(client, vars["user"], event.team!);
        await client.reactions.add({channel: event.channel, name: "thumbsup", timestamp: event.ts})
        return;
    } else if (command_match(event.text, config.command_demote, context.botUserId!)) {
        if (!(await client.users.info({user: event.user})).user?.is_owner) {
            console.log("not owner");
            return;
        }
        const vars = extractMessageVars(event.text, config.command_promote);
        await demote(client, vars["user"], event.team!);
        await client.reactions.add({channel: event.channel, name: "thumbsup", timestamp: event.ts})
        return;
    } else if (command_match(event.text, config.command_give_counted, context.botUserId!)) {
        const vars = extractMessageVars(event.text, config.command_give_counted);
        await applyKarmaChange(event.team!, parseInt(vars["n"]), event.user, vars["user"], context.botUserId!, client, event.channel, event.thread_ts ?? event.ts);
    } else if (command_match(event.text, config.command_take_counted, context.botUserId!)) {
        const vars = extractMessageVars(event.text, config.command_give_counted);
        await applyKarmaChange(event.team!, parseInt(vars["n"]), event.user, vars["user"], context.botUserId!, client, event.channel, event.thread_ts ?? event.ts);
    }
});

(async () => {
    await app.start(process.env.PORT || 3000);

    //db.collection("servers".doc(app.client.team.))

    console.log('launched');
})();
