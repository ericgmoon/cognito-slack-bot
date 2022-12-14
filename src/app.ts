import {Context} from "@slack/bolt";
import {WebClient} from "@slack/web-api/dist/WebClient"
import {GenericMessageEvent} from "@slack/bolt/dist/types/events/message-events";


const {App, AwsLambdaReceiver} = require('@slack/bolt');
const config = require("./config.json");

import {
    DynamoDBClient,
    GetItemCommand,
    UpdateItemCommand
} from "@aws-sdk/client-dynamodb"
import {AwsCallback, AwsEvent} from "@slack/bolt/dist/receivers/AwsLambdaReceiver";


const dynamoDbClient = new DynamoDBClient({
    region: "ap-southeast-2"
});

const awsLambdaReceiver = new AwsLambdaReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET
});

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    receiver: awsLambdaReceiver
});


const replacementVars: string[] = ["deltaKarma", "totalKarma", "user", "maxKarma", "minKarma", "botUser"]

function rescape(str: string): string {
    let res = ""
    for (const c of str) {
        if ([".", "+", "*", "?", "^", "$", "(", ")", "[", "]", "{", "}", "|", "\\", "-"].includes(c)) {
            res += `\\${c}`;
        } else {
            res += c;
        }
    }
    return res;
}

function replaceMessageVars(message: string, args: { [key: string]: any }): string {
    for (const replacementVar of replacementVars) {
        if (args[replacementVar]) {
            if (replacementVar.endsWith("User") || replacementVar.endsWith("user")) {
                message = message.replace(`\${${replacementVar}}`, `<@${args[replacementVar].toString()}>`);
            } else {
                message = message.replace(`\${${replacementVar}}`, args[replacementVar].toString());
            }
        }
    }
    return message.replace(new RegExp("\\$\\[\\w+]", "g"), `[\\w@<>${rescape(config.command_take_tallied_tally)}${rescape(config.command_give_tallied_tally)}]+`);
}

//this is harder than i thought whoops
function extractMessageVarsLegacy(message: string, pattern: string) {
    const result: { [key: string]: string } = {};
    const extractions = new RegExp("\\$\\[\\w+]", "g");
    const extractionsCopy = new RegExp("\\$\\[\\w+]");
    let match;
    while (match = extractions.exec(pattern)) {
        let pullPattern = pattern.slice(0, match.index).replace(extractionsCopy, `[\\w@<>${rescape(config.command_take_tallied_tally)}${rescape(config.command_give_tallied_tally)}]+`);
        let value = message.replace(new RegExp(pullPattern), "").match(`[\\w@<>${rescape(config.command_take_tallied_tally)}${rescape(config.command_give_tallied_tally)}]+`);
        const varName = match[0].slice(2, match[0].length - 1);
        result[varName] = value![0];
    }
    return result;
}

//this is harder than i thought whoops
function extractMessageVars(message: string, pattern: string, regexPattern: string) {
    const result: {[key: string]: string} = {};
    // Run regex pattern
    console.log(`looking for: ${regexPattern}`);
    let value: any = message.match(new RegExp(regexPattern));
    if(!value) return result;
    console.log(`value: ${value}`)
    // Extracts the varName from the pattern
    const extractions = new RegExp("\\$\\[\\w+]", "g");
    const extractionsCopy = new RegExp("\\$\\[\\w+]");
    let match;
    let i = 0;
    while (match = extractions.exec(pattern)) {
        console.log(`match: ${match}`)
        const varName = match[0].slice(2, match[0].length - 1);
        if (varName.endsWith("user") || varName.endsWith("User")) {
            // remove <@ and > for usernames
            result[varName] = value![i].slice(2, value![i].length - 1);
        } else if (varName === "tally" || varName === "n"){
            // remove ' +' and ' -', as the first +/- does not count
            result[varName] = value![i].slice(2, value![i].length);
        } else {
            result[varName] = value![i];
        }
        i++;
    }
    console.log(result);
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
    let postPromise: Promise<any> | null = null;
    const data = ((await dynamoDbClient.send(new GetItemCommand({
        TableName: "karma",
        Key: {
            "uid": {
                "S": team
            }
        },
        AttributesToGet: ["staff", "karma"]
    }))).Item)!

    const staff: string[] = data["staff"]["L"]!.map(item => item["S"]!);



    // student -/> student
    // student -> staff
    // staff -> staff
    // staff -> student

    let currentKarma = 0;

    const karmaData = data["karma"]["M"]!;
    if (target in karmaData) {
        currentKarma = parseInt(karmaData[target]["N"]!);
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
    } else if (currentKarma + deltaKarma > config.max_karma) {
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
         if (deltaKarma > config.max_karma_give_per_message) {
            deltaKarma = config.max_karma_give_per_message;
            postPromise = postToChannel(client, channel, thread, replaceMessageVars(config.message_exceed_give_per_message, {
                deltaKarma: deltaKarma,
                totalKarma: currentKarma + deltaKarma,
                user: target,
                botUser: botUser,
                minKarma: config.min_karma,
                max_karma: config.max_karma
            }));
        } else if (deltaKarma < config.max_karma_take_per_message) {
            deltaKarma = config.max_karma_take_per_message;
            postPromise = postToChannel(client, channel, thread, replaceMessageVars(config.message_exceed_take_per_message, {
                deltaKarma: deltaKarma,
                totalKarma: currentKarma + deltaKarma,
                user: target,
                botUser: botUser,
                minKarma: config.min_karma,
                max_karma: config.max_karma
            }));
        } else {
            postPromise = postToChannel(client, channel, thread, replaceMessageVars(deltaKarma > 0 ? config.message_give : config.message_take, {
                deltaKarma: deltaKarma,
                totalKarma: currentKarma + deltaKarma,
                user: target,
                botUser: botUser,
                minKarma: config.min_karma,
                maxKarma: config.max_karma
            }));
        }

        console.log("applying karma");
        await dynamoDbClient.send(new UpdateItemCommand({
            "TableName": "karma",
            Key: {
                "uid": {
                    "S": team
                }
            },
            UpdateExpression: "ADD karma.#u :n",
            ExpressionAttributeNames: {
                "#u": target
            },
            ExpressionAttributeValues: {
                ":n": {
                    "N": deltaKarma.toString()
                }
            }
        }));
    }

    await postPromise;

}

async function promote_admins(client: WebClient, team_id: string) {
    const admins: string[] = []
    for (const member of (await client.users.list({team_id: team_id})).members!) {
        if (member.is_admin) {
            admins.push(member.id!);
        }
    }

    await dynamoDbClient.send(new UpdateItemCommand({
        "TableName": "karma",
        Key: {
            "uid": {
                "S": team_id
            }
        },
        UpdateExpression: "SET staff=:s",
        ExpressionAttributeValues: {
            ":s": {
                "L": (admins.map(admin => ({"S": admin})))
            }
        }
    }));
}

async function promote(client: WebClient, user: string, team_id: string) {
    await dynamoDbClient.send(new UpdateItemCommand({
        "TableName": "karma",
        Key: {
            uid: {
                "S": team_id
            }
        },
        UpdateExpression: "ADD staff :s",
        ExpressionAttributeValues: {
            ":s": {
                "SS": [user]
            }
        }
    }));
}

async function demote(client: WebClient, user: string, team_id: string) {
    await dynamoDbClient.send(new UpdateItemCommand({
        "TableName": "karma",
        Key: {
            uid: {
                "S": team_id
            }
        },
        UpdateExpression: "DELETE staff :s",
        ExpressionAttributeValues: {
            ":s": {
                "SS": [user]
            }
        }
    }));
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
        if (!(await client.users.info({user: event.user})).user?.is_admin) {
            console.log("not admin");
            return;
        }
        await promote_admins(client, event.team!);
        await client.reactions.add({channel: event.channel, name: "thumbsup", timestamp: event.ts});
        return;
    } else if (command_match(event.text, config.command_promote, context.botUserId!)) {
        if (!(await client.users.info({user: event.user})).user?.is_owner) {
            console.log("not owner");
            return;
        }
        const vars = extractMessageVarsLegacy(event.text, config.command_promote);
        await promote(client, vars["user"], event.team!);
        await client.reactions.add({channel: event.channel, name: "thumbsup", timestamp: event.ts});
        return;
    } else if (command_match(event.text, config.command_demote, context.botUserId!)) {
        if (!(await client.users.info({user: event.user})).user?.is_owner) {
            console.log("not owner");
            return;
        }
        const vars = extractMessageVarsLegacy(event.text, config.command_promote);
        await demote(client, vars["user"], event.team!);
        await client.reactions.add({channel: event.channel, name: "thumbsup", timestamp: event.ts});
        return;
    }


    if (command_match(event.text, config.command_give_counted_regex, context.botUserId!)) {
        console.log("give counted");
        const vars = extractMessageVars(event.text, config.command_give_counted, config.command_give_counted_regex);
        if (!isNaN(parseInt(vars["n"]))) {
            await applyKarmaChange(event.team!, parseInt(vars["n"]), event.user, vars["user"], context.botUserId!, client, event.channel, event.thread_ts ?? event.ts);
        }
    } else if (command_match(event.text, config.command_take_counted_regex, context.botUserId!)) {
        console.log("take counted");
        const vars = extractMessageVars(event.text, config.command_take_counted, config.command_take_counted_regex);
        if (!isNaN(parseInt(vars["n"]))) {
            await applyKarmaChange(event.team!, -parseInt(vars["n"]), event.user, vars["user"], context.botUserId!, client, event.channel, event.thread_ts ?? event.ts);
        }
    } else if (command_match(event.text, config.command_give_tallied_regex, context.botUserId!)) {
        console.log("giving tallied");
        const vars = extractMessageVars(event.text, config.command_give_tallied, config.command_give_tallied_regex);
        console.log(vars);
        for (let i = 0; i < vars["tally"].length; i++) {
            if (vars["tally"][i] != config.command_give_tallied_tally) {
                return;
            }
        }
        await applyKarmaChange(event.team!, vars["tally"].length, event.user, vars["user"], context.botUserId!, client, event.channel, event.thread_ts ?? event.ts);
    } else if (command_match(event.text, config.command_take_tallied_regex, context.botUserId!)) {
        console.log("taking tallied");
        const vars = extractMessageVars(event.text, config.command_take_tallied, config.command_take_tallied_regex);
        for (let i = 0; i < vars["tally"].length; i++) {
            if (vars["tally"][i] != config.command_take_tallied_tally) {
                return;
            }
        }
        await applyKarmaChange(event.team!, -vars["tally"].length, event.user, vars["user"], context.botUserId!, client, event.channel, event.thread_ts ?? event.ts);
    }
});


module.exports.handler = async (event: AwsEvent, context: any, callback: AwsCallback) => {
    const handler = await awsLambdaReceiver.start();
    return handler(event, context, callback);
}
