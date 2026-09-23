import {
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
  DescribeInstancesCommand,
} from '@aws-sdk/client-ec2';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const instanceId = process.env.INSTANCE_ID!;
const serverIp = process.env.SERVER_IP!;
const webhookParam = process.env.DISCORD_WEBHOOK_PARAM!;
const savesBucket = process.env.SAVES_BUCKET!;

const GAME_PORT = 2456;

const ec2 = new EC2Client({ region: process.env.AWS_REGION });
const ssm = new SSMClient({ region: process.env.AWS_REGION });
const s3 = new S3Client({ region: process.env.AWS_REGION });

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

interface ServerStatus {
  ready: boolean;
  joinCode: string;
  players: number;
  version: string;
  updatedAt: string;
}

/**
 * A running instance does not mean a joinable server: the game takes minutes to
 * install and load after the box boots, and it can crash-loop while EC2 still
 * reports 'running'.
 *
 * Probing the Steam query port does NOT work here. With crossplay enabled the
 * server registers through PlayFab and never opens a Steam query server, so
 * A2S_INFO times out even on a perfectly healthy world. Instead the instance
 * publishes a heartbeat to S3 once a minute and we read that.
 */
const getServerStatus = async (): Promise<ServerStatus | undefined> => {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: savesBucket, Key: 'status.json' })
    );
    const body = await res.Body?.transformToString();
    if (!body) return undefined;

    const status = JSON.parse(body) as ServerStatus;

    // A heartbeat older than a few minutes means the publisher died, so the
    // contents no longer describe reality and must not be reported as current.
    const ageMs = Date.now() - new Date(status.updatedAt).getTime();
    if (ageMs > 5 * 60 * 1000) {
      console.log(`Heartbeat is stale (${Math.round(ageMs / 1000)}s old)`);
      return undefined;
    }
    return status;
  } catch (err) {
    console.log('No readable heartbeat', err);
    return undefined;
  }
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
  } else if (state !== 'running') {
    message = `Valheim server is ${state}. Use \`/valheim start\` to bring it up.`;
  } else {
    // The box is up, but that says nothing about whether the game is serving
    const status = await getServerStatus();

    if (status?.ready) {
      const who =
        status.players === 1 ? '1 player online' : `${status.players} players online`;
      message =
        `Valheim server is up at \`${serverIp}:${GAME_PORT}\`\n` +
        `Join code: \`${status.joinCode}\` (console/Game Pass players need this)\n` +
        `${who} · ${status.version}`;
    } else if (status) {
      message =
        'The box is running and Valheim is still starting up — it installs and ' +
        'loads the world first. Give it a couple of minutes.';
    } else {
      message =
        'The box is running, but Valheim is **not reporting in**. It may still be ' +
        'booting, or the server has failed to start. Check again shortly.';
    }
    console.log(`Heartbeat: ${status ? JSON.stringify(status) : 'none'}`);
  }

  await postToDiscord(message);
  console.log(message);

  return { statusCode: 200, state, message };
};
