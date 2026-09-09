#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ValheimHostingStack } from './valheim-hosting-stack';
import { Config } from './config';

const app = new cdk.App();
new ValheimHostingStack(app, 'ValheimHostingStack', {
  env: { account: Config.account, region: Config.region },
});
