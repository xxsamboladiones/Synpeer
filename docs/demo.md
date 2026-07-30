# Reproducible Demo

## Two Peers on Different Computers

### Option A: Supabase Realtime signaling

1. Install the same Synpeer revision on both computers.
2. Run `npm ci`.
3. Copy `.env.example` to `.env`.
4. Put the same Supabase URL and publishable/anon key in both `.env` files.
5. Run `npm run web` on both computers.
6. Open each app in a separate browser profile and create a different identity.
7. On peer A, open **Peers**, create a private network and copy its invite.
8. On peer B, join that private network using the invite.
9. On peer A, approve peer B.
10. Keep both apps open and select **Connect** if automatic connection has not
    already opened the DataChannel.
11. Confirm that each peer reports the other as connected and verified.

No Supabase SQL schema is required. Realtime Broadcast and Presence must be
available for the project.

### Option B: self-hosted signaling on a LAN

On the signaling computer:

```bash
npm ci
npm run signaling
```

Allow inbound TCP port `8787` in the host firewall. Set this on both peers:

```dotenv
EXPO_PUBLIC_SYNPEER_SIGNALING_URL=ws://SIGNALING_LAN_IP:8787
```

Then follow steps 5 through 11 above. The `/health` endpoint reports only
ephemeral process state:

```text
http://SIGNALING_LAN_IP:8787/health
```

Do not expose the included server to the public Internet without authentication,
TLS, rate limits and deployment hardening.

## Functional Checks

After connection:

1. Create a text post on peer A and confirm it appears on peer B without reload.
2. Like and comment from peer B and confirm peer A receives the update.
3. Publish a small image and confirm chunk validation and reconstruction.
4. Disconnect peer B, create a post on A, reconnect B and confirm incremental
   catch-up.
5. Send a chat message, verify delivery/read state and ensure the message remains
   after a page reload.

Record browser version, operating system, network topology, TURN configuration
and the exact Git commit when reporting a failure.

## Automated Four-Peer Mesh

Install Playwright's Chromium once:

```bash
npx playwright install chromium
```

Run the mesh suite:

```bash
npm run test:e2e:mesh
```

Run each mesh scenario three times:

```bash
npm run test:e2e:mesh:repeat
```

The suite creates isolated browser peers and exercises graph propagation,
partitions/recovery, durable chat relay and media replication. It does not use
the public Internet and therefore does not replace real NAT/TURN testing.

## Evidence to Capture for an Alpha Release

- exact commit SHA;
- output of `npm run verify`;
- output of `npm run test:e2e:mesh:repeat`;
- two-computer browser and network versions;
- a short screen recording showing identity, connection and live replication;
- screenshots containing no private keys, backups, tokens or personal test data.
