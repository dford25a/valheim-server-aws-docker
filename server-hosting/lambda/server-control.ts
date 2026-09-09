import {
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
  DescribeInstancesCommand,
} from '@aws-sdk/client-ec2';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const instanceId = process.env.INSTANCE_ID!;
const serverIp = process.env.SERVER_IP!;
const webhookParam = process.env.DISCORD_WEBHOOK_PARAM!;

const ec2 = new EC2Client({ region: process.env.AWS_REGION });
const ssm = new SSMClient({ region: process.env.AWS_REGION });

export type ControlAction = 'start' | 'stop' | 'status';
export interface ControlEvent {
  action: ControlAction;
}

// Cached across invocations so a warm container skips the SSM round trip
let webhookUrl: string | undefined;

const getWebhookUrl = async (): Promise<string | undefined> => {
  if (webhookUrl) return webhookUrl;
  try {
    const res = await ssm.send(
      new GetParameterCommand({ Name: webhookParam, WithDecryption: true })
    );
    webhookUrl = res.Parameter?.Value;
    return webhookUrl;
  } catch (err) {
    console.error('Could not read Discord webhook from SSM', err);
    return undefined;
  }
};

const postToDiscord = async (content: string): Promise<void> => {
  const url = await getWebhookUrl();
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch (err) {
    // A failed notification must never fail the actual start/stop
    console.error('Failed to post to Discord webhook', err);
  }
};

const getState = async (): Promise<string> => {
  const res = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  return res.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? 'unknown';
};

export const handler = async (event: ControlEvent) => {
  const action = event?.action ?? 'status';
  const state = await getState();
  console.log(`Action '${action}' requested; instance ${instanceId} is '${state}'`);

  let message: string;

  if (action === 'start') {
    if (state === 'running') {
      message = `Valheim server is already up at \`${serverIp}:2456\``;
    } else if (state === 'pending') {
      message = 'Valheim server is already booting, give it a minute.';
    } else {
      await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
      // The container posts its own "server started" notice once Valheim is actually
      // accepting connections, which is a good 3-5 minutes after the instance boots.
      message = `Booting the Valheim server. It will be joinable at \`${serverIp}:2456\` in a few minutes.`;
    }
  } else if (action === 'stop') {
    if (state === 'stopped' || state === 'stopping') {
      message = 'Valheim server is already shut down.';
    } else {
      // The world is saved to S3 by the shutdown hook in install.sh before the box dies
      await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
      message = 'Shutting the Valheim server down and backing the world up to S3.';
    }
  } else {
    message =
      state === 'running'
        ? `Valheim server is up at \`${serverIp}:2456\``
        : `Valheim server is ${state}.`;
  }

  await postToDiscord(message);
  console.log(message);

  return { statusCode: 200, state, message };
};
