import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";
import cors from "cors";

dotenv.config();

if (!process.env.DIFY_API_URL) throw new Error("DIFY API URL is required.");

function generateId() {
  let result = "";
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 29; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

const app = express();

const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors()); // Handle preflight requests
app.use(bodyParser.json());

const botType = process.env.BOT_TYPE || 'Chat';
const inputVariable = process.env.INPUT_VARIABLE || '';
const outputVariable = process.env.OUTPUT_VARIABLE || '';

let apiPath;
switch (botType) {
  case 'Chat':
    apiPath = '/chat-messages';
    break;
  case 'Completion':
    apiPath = '/completion-messages';
    break;
  case 'Workflow':
    apiPath = '/workflows/run';
    break;
  default:
    throw new Error('Invalid bot type in the environment variable.');
}

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>DIFY2OPENAI</title>
      </head>
      <body>
        <h1>Dify2OpenAI</h1>
        <p>Congratulations! Your project has been successfully deployed.</p>
      </body>
    </html>
  `);
});

app.post("/v1/chat/completions", async (req, res) => {
  try {
    console.log('Incoming request:', {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: req.body
    });

    const authHeader = req.headers["authorization"] || req.headers["Authorization"];
    if (!authHeader) {
      return res.status(401).json({
        code: 401,
        errmsg: "Unauthorized.",
      });
    }
    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({
        code: 401,
        errmsg: "Unauthorized.",
      });
    }

    const data = req.body;
    const messages = data.messages;
    let queryString;
    if (botType === 'Chat') {
      const lastMessage = messages[messages.length - 1];
      queryString = `here is our talk history:\n'''\n${messages
        .slice(0, -1) 
        .map((message) => `${message.role}: ${message.content}`)
        .join('\n')}\n'''\n\nhere is my question:\n${lastMessage.content}`;
    } else if (botType === 'Completion' || botType === 'Workflow') {
      queryString = messages[messages.length - 1].content;
    }
    const stream = data.stream !== undefined ? data.stream : false;
    let requestBody;
    if (inputVariable) {
      requestBody = {
        inputs: { [inputVariable]: queryString },
        response_mode: "streaming",
        conversation_id: "",
        user: "apiuser",
        auto_generate_name: false
      };
    } else {
      requestBody = {
        "inputs": {},
        query: queryString,
        response_mode: "streaming",
        conversation_id: "",
        user: "apiuser",
        auto_generate_name: false
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 30000); // 30 seconds timeout

    try {
      const resp = await fetch(process.env.DIFY_API_URL + apiPath, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!resp.ok) {
        const errorText = await resp.text();
        console.error(`Error from DIFY API: ${resp.status} ${resp.statusText}`, errorText);
        throw new Error(`DIFY API responded with ${resp.status} ${resp.statusText}`);
      }

      let isResponseEnded = false;

      if (stream) {
        res.setHeader("Content-Type", "text/event-stream");
        const stream = resp.body;
        let buffer = "";
        let isFirstChunk = true;

        stream.on("data", (chunk) => {
          try {
            buffer += chunk.toString();
            let lines = buffer.split("\n");

            for (let i = 0; i < lines.length - 1; i++) {
              let line = lines[i].trim();

              if (!line.startsWith("data:")) continue;
              line = line.slice(5).trim();
              let chunkObj;
              try {
                if (line.startsWith("{")) {
                  chunkObj = JSON.parse(line);
                } else {
                  continue;
                }
              } catch (error) {
                console.error("Error parsing chunk:", error);
                continue;
              }

              if (chunkObj.event === "message" || chunkObj.event === "agent_message" || chunkObj.event === "text_chunk") {
                let chunkContent;
                if (chunkObj.event === "text_chunk") {
                  chunkContent = chunkObj.data.text;
                } else {
                  chunkContent = chunkObj.answer;
                }
        
                if (isFirstChunk) {
                  chunkContent = chunkContent.trimStart();
                  isFirstChunk = false;
                }
                if (chunkContent !== "") {
                  const chunkId = `chatcmpl-${Date.now()}`;
                  const chunkCreated = chunkObj.created_at;
                  
                  if (!isResponseEnded) {
                    res.write(
                      "data: " +
                        JSON.stringify({
                          id: chunkId,
                          object: "chat.completion.chunk",
                          created: chunkCreated,
                          model: data.model,
                          choices: [
                            {
                              index: 0,
                              delta: {
                                content: chunkContent,
                              },
                              finish_reason: null,
                            },
                          ],
                        }) +
                        "\n\n"
                    );
                  }
                }
              } else if (chunkObj.event === "workflow_finished" || chunkObj.event === "message_end") {
                const chunkId = `chatcmpl-${Date.now()}`;
                const chunkCreated = chunkObj.created_at;
                if (!isResponseEnded) {
                  res.write(
                    "data: " +
                      JSON.stringify({
                        id: chunkId,
                        object: "chat.completion.chunk",
                        created: chunkCreated,
                        model: data.model,
                        choices: [
                          {
                            index: 0,
                            delta: {},
                            finish_reason: "stop",
                          },
                        ],
                      }) +
                      "\n\n"
                  );
                }
                if (!isResponseEnded) {
                  res.write("data: [DONE]\n\n");
                }

                res.end();
                isResponseEnded = true;
              } else if (chunkObj.event === "error") {
                console.error(`Error: ${chunkObj.code}, ${chunkObj.message}`);
                res
                  .status(500)
                  .write(
                    `data: ${JSON.stringify({ error: chunkObj.message })}\n\n`
                  );
                  
                if (!isResponseEnded) {
                  res.write("data: [DONE]\n\n");
                }

                res.end();
                isResponseEnded = true;
              }
            }

            buffer = lines[lines.length - 1];
          } catch (error) {
            console.error("Error processing stream chunk:", error);
            if (!isResponseEnded) {
              res.status(500).write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
              res.write("data: [DONE]\n\n");
              res.end();
              isResponseEnded = true;
            }
          }
        });

        stream.on("error", (error) => {
          console.error("Stream error:", error);
          if (!isResponseEnded) {
            res.status(500).write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
            isResponseEnded = true;
          }
        });

        res.on('close', () => {
          if (stream && !stream.destroyed) {
            stream.destroy();
          }
        });
      } else {
        let result = "";
        let usageData = "";
        let hasError = false;
        let messageEnded = false;
        let buffer = "";
        let skipWorkflowFinished = false;

        const stream = resp.body;
        stream.on("data", (chunk) => {
          buffer += chunk.toString();
          let lines = buffer.split("\n");

          for (let i = 0; i < lines.length - 1; i++) {
            const line = lines[i].trim();
            if (line === "") continue;
            let chunkObj;
            try {
              const cleanedLine = line.replace(/^data: /, "").trim();
              if (cleanedLine.startsWith("{") && cleanedLine.endsWith("}")) {
                chunkObj = JSON.parse(cleanedLine);
              } else {
                continue;
              }
            } catch (error) {
              console.error("Error parsing JSON:", error);
              continue;
            }

            if (
              chunkObj.event === "message" ||
              chunkObj.event === "agent_message"
            ) {
              result += chunkObj.answer;
              skipWorkflowFinished = true;
            } else if (chunkObj.event === "message_end") {
              messageEnded = true;
              usageData = {
                prompt_tokens: chunkObj.metadata.usage.prompt_tokens || 100,
                completion_tokens:
                  chunkObj.metadata.usage.completion_tokens || 10,
                total_tokens: chunkObj.metadata.usage.total_tokens || 110,
              };
            } else if (chunkObj.event === "workflow_finished" && !skipWorkflowFinished) {
              messageEnded = true;
              const outputs = chunkObj.data.outputs;
              if (outputVariable) {
                result = outputs[outputVariable];
              } else {
                result = outputs;
              }
              result = String(result);
              usageData = {
                prompt_tokens: chunkObj.metadata?.usage?.prompt_tokens || 100,
                completion_tokens: chunkObj.metadata?.usage?.completion_tokens || 10,
                total_tokens: chunkObj.data.total_tokens || 110,
              };
            } else if (chunkObj.event === "error") {
              console.error(`Error: ${chunkObj.code}, ${chunkObj.message}`);
              hasError = true;
              break;
            }
          }

          buffer = lines[lines.length - 1];
        });

        stream.on("end", () => {
          if (hasError) {
            res
              .status(500)
              .json({ error: "An error occurred while processing the request." });
          } else if (messageEnded) {
            const formattedResponse = {
              id: `chatcmpl-${generateId()}`,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: data.model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: result.trim(),
                  },
                  logprobs: null,
                  finish_reason: "stop",
                },
              ],
              usage: usageData,
              system_fingerprint: "fp_2f57f81c11",
            };
            const jsonResponse = JSON.stringify(formattedResponse, null, 2);
            res.set("Content-Type", "application/json");
            res.send(jsonResponse);
          } else {
            res.status(500).json({ error: "Unexpected end of stream." });
          }
        });

        res.on('close', () => {
          if (stream && !stream.destroyed) {
            stream.destroy();
          }
        });
      }
    } catch (error) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') {
        console.error('Request timed out');
        res.status(504).json({ error: 'Request timed out' });
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error("Error in /v1/chat/completions:", error);
    res.status(500).json({ error: error.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
