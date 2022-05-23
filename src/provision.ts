import {Context} from "@slack/bolt";
import {WebClient} from "@slack/web-api/dist/WebClient"
import {GenericMessageEvent} from "@slack/bolt/dist/types/events/message-events";


const {App, AwsLambdaReceiver} = require('@slack/bolt');
const config = require("./config.json");

import {
    DynamoDBClient,
    GetItemCommand, PutItemCommand,
    UpdateItemCommand
} from "@aws-sdk/client-dynamodb"
import {AwsCallback, AwsEvent} from "@slack/bolt/dist/receivers/AwsLambdaReceiver";


const dynamoDbClient = new DynamoDBClient({
    region: "us-east-1"
});


const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET
});

(async () => {
    const auth = (await app.client.auth.test());
    const teamId = auth['team_id'];
    const userId = auth['user_id'];

    if (((await dynamoDbClient.send(new GetItemCommand({
        TableName: "karma",
        Key: {
            "uid": {
                "S": teamId
            }
        }
    }))).Item) == undefined) {
        await dynamoDbClient.send(new PutItemCommand({
            TableName: "karma",
            Item: {
                "uid": {
                    "S": teamId
                },
                "staff": {
                    "SS": [userId]
                },
                "karma": {
                    "M": {}
                }
            }
        }))
    }
})();