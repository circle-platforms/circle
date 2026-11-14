// An MCP connection over WebSocket, for a server whose entry says `"type": "ws"`. The MCP library has no transport for
// it, so Circle keeps this one: a socket that speaks the `mcp` subprotocol and carries one JSON-RPC message in each
// text frame, with Node's own WebSocket.
import {
  parseJSONRPCMessage,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/client';

/** The subprotocol a client asks for when it opens the socket. */
const SUBPROTOCOL = 'mcp';

export class WebSocketClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private socket?: WebSocket;
  constructor(private readonly url: URL) {}
  start(): Promise<void> {
    if (this.socket)
      throw new Error('the WebSocket transport has started already');
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url, SUBPROTOCOL);
      this.socket = socket;
      let opened = false;
      socket.onopen = () => {
        opened = true;
        resolve();
      };
      socket.onerror = (event) => {
        const error =
          'error' in event && event.error instanceof Error
            ? event.error
            : new Error(`WebSocket error at ${this.url.origin}`);
        if (!opened) reject(error);
        this.onerror?.(error);
      };
      socket.onclose = () => {
        if (!opened)
          reject(
            new Error(
              `the WebSocket at ${this.url.origin} closed before it opened`,
            ),
          );
        this.onclose?.();
      };
      socket.onmessage = (event: MessageEvent) => {
        let message: JSONRPCMessage;
        try {
          message = parseJSONRPCMessage(JSON.parse(String(event.data)));
        } catch (error) {
          this.onerror?.(
            error instanceof Error ? error : new Error(String(error)),
          );
          return;
        }
        this.onmessage?.(message);
      };
    });
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN)
      throw new Error('not connected');
    this.socket.send(JSON.stringify(message));
  }
  async close(): Promise<void> {
    this.socket?.close();
  }
}
