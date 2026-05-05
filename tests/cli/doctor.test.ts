import { describe, expect, it } from "vitest";
import { checkHostedWorker } from "../../src/cli/doctor.js";
import type { NctxConfig } from "../../src/types.js";

const config: NctxConfig = {
  mode: "hosted",
  install_token: "nctx_it_test_token_that_is_long_enough",
  proxy_url: "https://worker.example/",
  project_name: "demo",
  version: "0.1.0"
};

describe("doctor Worker checks", () => {
  it("runs a lightweight authenticated Worker isolation probe", async () => {
    const requests: Request[] = [];

    const checks = await checkHostedWorker(config, {
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({
          results: [
            {
              id: "ctx_1",
              agent_source: "nctx-claude-code",
              tags: ["install:server"]
            }
          ]
        });
      }
    });

    expect(checks.map(([name, ok]) => [name, ok])).toEqual([
      ["Worker reachable", true],
      ["hosted tag isolation", true]
    ]);
    expect(requests).toHaveLength(1);
    const request = requests[0] as Request;
    expect(request.url).toBe(
      "https://worker.example/contexts/semantic-search?q=__nctx_doctor_probe__&limit=1&include_highlights=false"
    );
    expect(request.headers.get("Authorization")).toBe(`Bearer ${config.install_token}`);
  });

  it("flags a live probe response that is not isolated to the hosted agent source", async () => {
    const checks = await checkHostedWorker(config, {
      fetchImpl: async () =>
        Response.json({
          results: [
            {
              id: "ctx_foreign",
              agent_source: "other-agent",
              tags: ["install:server"]
            }
          ]
        })
    });

    expect(checks.map(([name, ok]) => [name, ok])).toEqual([
      ["Worker reachable", true],
      ["hosted tag isolation", false]
    ]);
  });
});
