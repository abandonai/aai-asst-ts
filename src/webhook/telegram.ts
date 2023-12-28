import {APIGatewayEvent, Handler} from "aws-lambda";
import redisClient from "../utils/redisClient";
import OpenAI from "openai";
import sqsClient from "../utils/sqsClient";
import {SendMessageCommand} from "@aws-sdk/client-sqs";

export const handler: Handler = async (event: APIGatewayEvent, context) => {
  const body = JSON.parse(event?.body || '{}');
  const token = event.pathParameters?.proxy || undefined;

// do not process groups, bots and old messages(24h)
  if (
    body?.message?.chat?.id < 0 ||
    body?.message?.from?.is_bot ||
    body?.message?.date < Math.floor(new Date().getTime() / 1000) - 24 * 60 * 60
  ) {
    return {
      statusCode: 200,
      body: JSON.stringify({}),
    }
  }

  // Check assistant_id
  const assistant_id = await redisClient.get(`ASST_ID#${token}`);
  if (!assistant_id) {
    return {
      statusCode: 200,
      body: JSON.stringify({}),
    }
  }

  const openai = new OpenAI();
  const chat_id = body?.message?.chat?.id;
  const update_id = body?.update_id;

  // Check thread, if not exist, create
  let thread_id = await redisClient.get(
    `${assistant_id}:telegram:${chat_id}:thread_id`,
  );

  // Create new thread
  if (!thread_id || body?.message?.text?.trim() === "/start") {
    if (thread_id) {
      try {
        await openai.beta.threads.del(thread_id as string);
      } catch (e) {
        console.log("openai.beta.threads.del error", e);
      }
    }
    try {
      const { id } = await openai.beta.threads.create();
      thread_id = id;
      await redisClient.set(
        `${assistant_id}:telegram:${chat_id}:thread_id`,
        thread_id,
      );
    } catch (_) {
      console.log("openai.beta.threads.create error");
      return {
        statusCode: 200,
        body: JSON.stringify({}),
      }
    }
  }



  try {
    await Promise.all([
      openai.beta.threads.messages.create(thread_id as string, {
        role: "user",
        content: JSON.stringify(body),
      }),
      sqsClient.send(
        new SendMessageCommand({
          QueueUrl: process.env.AI_ASST_SQS_FIFO_URL,
          MessageBody: JSON.stringify({
            thread_id,
            assistant_id,
            update_id,
            token,
            chat_id,
          }),
          MessageAttributes: {
            intent: {
              StringValue: "threads.runs.create",
              DataType: "String",
            },
            from: {
              StringValue: "telegram",
              DataType: "String",
            },
          },
          MessageDeduplicationId: `${assistant_id}-${thread_id}-${update_id}`,
          MessageGroupId: `${assistant_id}-${thread_id}`,
        }),
      ),
    ]);
  } catch (_) {
    console.log("openai.beta.threads.messages.create error");
  }

  return {
    statusCode: 200,
    body: JSON.stringify({}),
  }
}