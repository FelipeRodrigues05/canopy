#!/usr/bin/env bash
# LocalStack "ready" hook: creates the FIFO queues the service depends on.
set -euo pipefail

DLQ_URL=$(awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true,MessageRetentionPeriod=1209600 \
  --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

# maxReceiveCount=5: after the 5th failed receive the broker moves the message to the DLQ.
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"true\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}" \
  >/dev/null

awslocal sqs create-queue \
  --queue-name wallet-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false \
  >/dev/null

echo "canopy queues ready"
