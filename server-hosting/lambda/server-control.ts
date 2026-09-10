import {
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
  DescribeInstancesCommand,
} from '@aws-sdk/client-ec2';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { createSocket } from 'node:dgram';

const instanceId = process.env.INSTANCE_ID!;
const serverIp = process.env.SERVER_IP!;
const webhookParam = process.env.DISCORD_WEBHOOK_PARAM!;

const GAME_PORT = 2456;
// Valheim answers Steam A2S queries on the game port + 1
const QUERY_PORT = GAME_PORT + 1;

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

/**
 * A running instance does not mean a joinable server: the container can be down
 * while EC2 still reports 'running', which reads as "up" to players who then cannot
 * connect. Probe the Steam query port (game port + 1) with an A2S_INFO packet so
 * status reflects the game rather than the box.
 */
const isGameReachable = (timeoutMs = 2500): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createSocket('udp4');
    // A2S_INFO: 0xFFFFFFFF header, 'T', then "Source Engine Query\0"
    const query = Buffer.concat([
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
      Buffer.from('Source Engine Query\0', 'ascii'),
    ]);

    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('message', () => finish(true));
    socket.once('error', () => finish(false));
    socket.send(query, QUERY_PORT, serverIp, (err) => {
      if (err) finish(false);
    });
  });

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
  } else if (state !== 'running') {
    message = `Valheim server is ${state}. Use \`/valheim start\` to bring it up.`;
  } else {
    // The box is up, but that says nothing about whether the game is serving
    const reachable = await isGameReachable();
    message = reachable
      ? `Valheim server is up at \`${serverIp}:${GAME_PORT}\``
      : `The server box is running, but Valheim is **not responding** on ` +
        `\`${serverIp}:${GAME_PORT}\`. It may still be loading the world — ` +
        `give it a couple of minutes and check again.`;
    console.log(`Game port probe: ${reachable ? 'reachable' : 'no response'}`);
  }

  await postToDiscord(message);
  console.log(message);

  return { statusCode: 200, state, message };
};
