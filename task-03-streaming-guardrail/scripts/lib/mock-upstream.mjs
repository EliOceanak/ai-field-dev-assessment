/**
 * Tiny scripted OpenAI-compatible provider used by `npm run demo` and `npm run bench`.
 *
 * It speaks the real wire protocol (HTTP + SSE) on an ephemeral port, so the scripts exercise the
 * same `node:http` path a reviewer would hit — with no model server, no GPU and no network.
 */
import { createServer } from 'node:http';

/** One SSE frame from an OpenAI-compatible chunk payload. */
export function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function chunkOf(delta, finishReason = null) {
  return {
    id: 'chatcmpl-demo',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'scripted-provider',
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
}

/**
 * @param {{ frames: Array<{ text: string, delayMs?: number }>, tokenDelayMs?: number }} options
 * @returns {Promise<{ url: string, port: number, sent: string[], close: () => Promise<void> }>}
 */
export async function startMockUpstream(options) {
  const frames = options.frames;
  const sent = [];

  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });

      let cancelled = false;
      res.on('close', () => {
        cancelled = true;
      });

      const writeNext = (index) => {
        if (cancelled || index >= frames.length) {
          res.end();
          return;
        }
        const frame = frames[index];
        setTimeout(
          () => {
            if (cancelled) return;
            sent.push(frame.text);
            res.write(frame.text);
            writeNext(index + 1);
          },
          frame.delayMs ?? options.tokenDelayMs ?? 0
        );
      };

      writeNext(0);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    port,
    url: `http://127.0.0.1:${port}/v1`,
    sent,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}
