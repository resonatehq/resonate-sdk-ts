import * as http from "node:http";
import { Logger } from "../loggers/logger";
import { TasksSource, TaskMessage, isTaskMessage } from "../tasksSource";
import * as utils from "../utils";

const STOP = "stop";

export class HttpTaskSource implements TasksSource {
  readonly url: URL;
  readonly generator: AsyncGenerator<TaskMessage, void, unknown>;
  readonly stopPromise: utils.PromiseWithResolvers<void> = utils.promiseWithResolvers<void>();

  /**
   * Constructs a new instance of the HttpTaskSource with the provided URL and an optional logger.
   *
   * @param url - A valid HTTP URL that the server will call with task.
   *              The URL must be a properly formatted, valid HTTP URL.
   *              If not port is defined in the URL port 3000 will be used by default.
   *              If the URL is not valid, an error will be thrown.
   * @param logger - An optional logger instance to use for logging. If not provided,
   *                 a new `Logger` instance will be created and used.
   */
  constructor(
    url: string,
    private logger: Logger = new Logger(),
  ) {
    if (!URL.canParse(url)) {
      throw new Error(`url: ${url}, given to tasks source is not valid.`);
    }

    this.url = new URL(url);
    this.generator = this._httpGenerator();
  }

  stop(): void {
    this.stopPromise.reject(STOP);
  }

  callbackUrl(): string {
    return this.url.href;
  }

  // Should only be called once to create the generator for the first time.
  // every call to in will create a new generator.
  private async *_httpGenerator(): AsyncGenerator<TaskMessage, void, unknown> {
    const requestQueue: string[] = []; // Queue of the bodies of the requests.
    let requestListener: (() => void) | undefined = undefined;

    const server = http.createServer(async (req, res) => {
      const body = await parseBody(req);
      if (req.url !== this.url.pathname) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end(`Unknown path: ${req.url}`);
      } else {
        requestQueue.push(body);

        if (requestListener) {
          requestListener();
        }

        res.writeHead(202, { "Content-Type": "text/plain" });
        return res.end("Request received");
      }
    });

    server.listen(+this.url.port || 3000, "0.0.0.0", () => {
      this.logger.info(`HTTP tasks source is running on '0.0.0.0' and port ${+this.url.port}`);
    });

    const waitForRequest = (): Promise<string> => {
      const taskPromise = new Promise((resolve) => {
        if (requestQueue.length > 0) {
          resolve(requestQueue.shift()!);
        } else {
          requestListener = () => resolve(requestQueue.shift()!);
        }
      });

      return Promise.race([taskPromise, this.stopPromise.promise]) as Promise<string>;
    };

    try {
      while (true) {
        const body = await waitForRequest();
        const taskMessage = JSON.parse(body);
        if (isTaskMessage(taskMessage)) {
          yield taskMessage;
        } else {
          this.logger.warn("Recived task with invalid fields: ", taskMessage);
        }
      }
    } catch (e) {
      if (e !== STOP) {
        throw e;
      }
    } finally {
      this.logger.info("Stoping server tasks source server.");
      server.close();
    }
  }
}

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const body: Uint8Array[] = [];
    req.on("data", (chunk) => {
      body.push(chunk);
    });
    req.on("end", () => {
      const fullBody = Buffer.concat(body).toString();
      resolve(fullBody);
    });
    req.on("error", (err) => {
      console.error("Error parsing body:", err);
      reject(err);
    });
  });
}
