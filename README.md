<h1 align="center">🧠mindcraft⛏️</h1>

## Personal development fork

This repository is the `hashtagakiaki/mindcraft` development fork used as the source owner for craft synchronization, farm skills, and server-confirmed mining. The `autonomy` branch is the fork's default branch and starts from upstream stable commit `b36eaf7e61b3f6bd031fdb531812b2e3c42b6c73`. Evaluation and play tooling export the full commit SHA pinned in `mindcraft-eval/mindcraft-source.json`. Craft synchronization, `tendNearbyFarm`, and mining sync are maintained here as normal source; play overlays remain owned by eval.

`tillAndSow` accepts a seed item name or a supported crop name (for example, `wheat` maps to `wheat_seeds`). In both survival and cheat modes it reports planting success only after the requested crop is observed; an existing different crop is not treated as success. Farm harvest counts require the target block to become air and this bot to collect a matching nearby drop. Bucket interactions require the expected inventory change, and bucket placement also checks the destination block. Door traversal waits for the open state, and lethal attacks report success only for the target entity's death event.

`tendNearbyFarm(bot, options = {})` defaults to one connected plot: it selects the nearest farmland within `searchRadius` (default 32), then follows all same-height edge-adjacent farmland, including empty soil. Water gaps and diagonal contacts do not connect plots. The selected plot can extend beyond `searchRadius`; an unloaded boundary throws before work starts. Use `startPosition: {x, y, z}` to select a particular farmland block. Use `{scope: 'radius', radius: 32}` to tend all farmland within a working radius instead. `radius` is only valid for radius scope; `searchRadius` and `startPosition` are only valid for connected scope. Both modes accept `seedReserve` (default 1) and `chestPosition`; omitted chest coordinates use a chest within 32 blocks after tending. One call performs one cycle and returns confirmed `{harvested, planted, stored}` counts; missing seeds or unreachable crops are not a claim of completion. This options object replaces the old positional arguments.

For local development, keep this full-history clone separate from the read-only upstream checkout at `mindcraft-eval/runtime/upstream`. Reuse the existing compatible `node_modules` only as a read-only dependency input; do not run `npm install`, `npm ci`, or postinstall in the shared dependency tree. See [AGENTS.md](AGENTS.md) for repository, runtime, and live-server boundaries.

Optional shared place memory is configured at MindServer startup in the root `settings.js` with both `place_state_dir` (an absolute path) and `place_world_id` (a UUID). Leave both `null` to keep place memory disabled. These are process-wide settings and are not editable through individual agent settings; agent processes receive only the enabled flag and world ID, not the state path. MindServer stores each namespace in `place_state_dir/worlds/<place_world_id>.json`; place state loads independently of `load_memory` and survives bundle changes that reuse the same state root and world ID. Changing the world ID selects a separate ledger and keeps the prior ledger. The state root has an exclusive `.place-store.lock`; only one MindServer may use that root at once. Normal SIGINT/SIGTERM and UI shutdown release the lock. After a crash, first verify that no MindServer can still write the state root, then remove the stale lock file before starting again. Never remove a lock while a writer may be active.

Saved places can be searched with `!findPlace("forest")`, inspected by stable ID with `!inspectPlace("<id>")`, and visited with `!goToPlace("<id>")`. `!rememberHere("name")` keeps its existing syntax and records the bot's current point as observed when persistent memory is enabled; otherwise it remains a session bookmark. `!recordPlaceHere("name", "shelter")` records a general point and purpose. A `base` record is a representative point, not proof that a structure exists around it. Use `!recordPlaceBlock("name", "farm", "food", x, y, z)` for a loaded target block; farm records require farmland and storage records require a chest or trapped chest. `!recordReportedPlace(...)` explicitly stores user-provided coordinates as unverified. Place IDs, personal aliases, home preferences, death bookmarks, observation timestamps, and explicit output-storage relations survive restart. Ambiguous search results must be selected by ID. Persistent travel checks dimension and reports the adapter's actual movement result; reaching an unverified coordinate does not make the place observed. Related storage must have the same dimension. NewAction receives only a limited async `places` SDK (search, inspect, record, verify, travel, farm, relation, and personal alias operations), never the RPC socket or state path. Useful resource locations should be recorded only from the bot's current position or a loaded target block matching the place kind; stale and user-reported coordinates remain visibly unverified until checked.

Run the offline craft, farm, mining, navigation, interaction, cancellation, furnace, management-reconnect, and process-lifecycle fixtures with `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/run-tests.cjs`. The runner builds disposable fixtures and does not start Minecraft, call an LLM API, or modify shared dependencies. The mining fixture uses read-only real Mineflayer digging, plugin loader, Block, and Tool implementations from eval's upstream dependency tree, and checks target air plus this bot's server `playerCollect` event. Farm harvesting, planting, reserve handling, and chest storage, as well as bucket, door, and combat interactions, use mocks; eval's live smoke only invokes the farm skill in a surveyed no-target area. Furnace tests use actual Mineflayer inventory/furnace plugins. Process tests spawn only disposable fixture-owned Node processes and clean them up in `finally`. Shutdown fixtures exercise actual `Agent.shutdown` and `ActionManager` behavior, task and Cooking setup guards, init signal/IPC handling, parent supervisor task-ending and owned-process cleanup, and MindServer hub/PlaceStore drain and close behavior. They distinguish successful task completion (exit code 0), retained abnormal exit codes, owned-process cleanup results, and shutdown-record save failures. These offline checks do not establish live in-game smelt→craft→equip behavior; that still requires isolated live verification.

### Action cancellation and reconnect behavior

Normal successful work, including smelting and furnace clearing, keeps the current Minecraft connection. A cooperative stop also keeps that connection. `!stop` suppresses automatic resume and goal retries; a later explicit user instruction may start new work after the old action settles. A replacement instruction waits for the prior action to settle before its body can mutate the world.

Timeouts, movement stalls, and rapid repeated failures request a bounded stop and recovery. When the old action settles safely, the bot checks confirmed state and tries one recovery/replan; unchanged repeated failures do not loop indefinitely. At the recovery limit, it pauses and reports the blocker while staying connected. A management-socket disconnect also pauses work; after Socket.IO reconnect, settings and place namespace are checked before registration and login resume, and autonomous/action execution stays gated until a fresh explicit human instruction arrives. Old commands and uncertain RPC mutations are not replayed.

LLM cancellation is a programmatic request cancellation, not a natural-language request for the model to stop. Cancelled or stale responses and staged code cannot execute. The Codex adapter waits for its registered helper/CLI process group to close before removing the request directory; process ownership guarantees apply to groups recorded by the live bot supervisor. An unsupported provider may continue computing remotely, but its stale answer is discarded.

Minecraft reconnect is reserved for an already lost connection, an old action/process that cannot be safely stopped or isolated, or an explicit restart initiated by a literal human `!restart` command or the management UI. LLM-generated `!restart` is rejected; recovery prompts are told not to restart. A normal success, cooperative cancellation, recovery attempt, or temporary management-socket loss does not reconnect the bot. A forced stop is reported as a stop failure until the old action or owned process is actually gone; a timeout or race alone is not treated as proof of settlement.

Mining sync corrects affected block-instance material data per bot so Mineflayer, Tool, and pathfinder use consistent pickaxe speeds without changing shared registries. It requires a reachable, current target; waits a bounded time for ground contact where applicable; and treats server block updates as authoritative for break completion. Collection requires both target-block air and a server `playerCollect` event for a tracked expected drop near that block. See [the investigation and implementation record](docs/mining-investigation-2026-09-30.md) for offline and isolated live results.

To publish a source update, make the source change on `autonomy`, run the offline test command, and push the reviewed commit to this fork. Then update the eval manifest to that exact full SHA and run the eval tests and isolated live smoke against the pin. Review and commit/push the eval change after those checks, then prepare a new play bundle. Keep the eval dependency tree read-only; do not reinstall packages as part of a source-only update. Activate a bundle only through the explicitly authorized bot-only cutover, which leaves the Minecraft server, world, and Ollama process running.

<h1 align="center">
  <a href="https://trendshift.io/repositories/9163" target="_blank"><img src="https://trendshift.io/api/badge/repositories/9163" alt="kolbytn%2Fmindcraft | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>
</h1>

<p align="center">Crafting minds for Minecraft with LLMs and <a href="https://prismarinejs.github.io/mineflayer/#/">Mineflayer!</a></p>

<p align="center">
  <a href="https://github.com/mindcraft-bots/mindcraft/blob/main/FAQ.md">FAQ</a> | 
  <a href="https://discord.gg/mp73p35dzC">Discord Support</a> | 
  <a href="https://www.youtube.com/watch?v=gRotoL8P8D8">Video Tutorial</a> | 
  <a href="https://kolbynottingham.com/mindcraft/">Blog Post</a> | 
  <a href="https://mindcraft-minecollab.github.io/index.html">Paper Website</a> | 
  <a href="https://github.com/mindcraft-bots/mindcraft/blob/main/minecollab.md">MineCollab</a>
</p>

> [!Caution]
Do not connect this bot to public servers with coding enabled. This project allows an LLM to write/execute code on your computer. The code is sandboxed, but still vulnerable to injection attacks. Code writing is disabled by default, you can enable it by setting `allow_insecure_coding` to `true` in `settings.js`. Ye be warned.

# Getting Started
## Requirements

- [Minecraft Java Edition](https://www.minecraft.net/en-us/store/minecraft-java-bedrock-edition-pc) (up to v1.21.11, recommend v1.21.6)
- [Node.js Installed](https://nodejs.org/) (Node v18 or v20 LTS recommended. Node v24+ may cause issues with native dependencies)
- At least one API key from a supported API provider. See [supported APIs](#model-customization). OpenAI is the default.

> [!Important]
> If installing node on windows, ensure you check `Automatically install the necessary tools`
>
> If you encounter `npm install` errors on macOS, see the [FAQ](FAQ.md#common-issues) for troubleshooting native module build issues

## Install and Run

1. Make sure you have the requirements above.

2. Download the [latest release](https://github.com/mindcraft-bots/mindcraft/releases/latest) and unzip it, or clone the repository.

3. Rename `keys.example.json` to `keys.json` and fill in your API keys (you only need one). The desired model is set in `andy.json` or other profiles. For other models refer to the table below.

4. In terminal/command prompt, run `npm install` from the installed directory

5. Start a minecraft world and open it to LAN on localhost port `55916`

6. Run `node main.js` from the installed directory

If you encounter issues, check the [FAQ](https://github.com/mindcraft-bots/mindcraft/blob/main/FAQ.md) or find support on [discord](https://discord.gg/mp73p35dzC). We are currently not very responsive to github issues. To run tasks please refer to [Minecollab Instructions](minecollab.md#installation)


# Configuration
## Model Customization

You can configure project details in `settings.js`. [See file.](settings.js)

You can configure the agent's name, model, and prompts in their profile like `andy.json`. The model can be specified with the `model` field, with values like `model: "gemini-2.5-pro"`. You will need the correct API key for the API provider you choose. See all supported APIs below.

<details>
<summary><strong>⭐ VIEW SUPPORTED APIs ⭐</strong></summary>

| API Name | Config Variable| Docs |
|------|------|------|
| `openai` | `OPENAI_API_KEY` | [docs](https://platform.openai.com/docs/models) |
| `google` | `GEMINI_API_KEY` | [docs](https://ai.google.dev/gemini-api/docs/models/gemini) |
| `anthropic` | `ANTHROPIC_API_KEY` | [docs](https://docs.anthropic.com/claude/docs/models-overview) |
| `xai` | `XAI_API_KEY` | [docs](https://docs.x.ai/docs) |
| `deepseek` | `DEEPSEEK_API_KEY` | [docs](https://api-docs.deepseek.com/) |
| `ollama` (local) | n/a | [docs](https://ollama.com/library) |
| `qwen` | `QWEN_API_KEY` | [Intl.](https://www.alibabacloud.com/help/en/model-studio/developer-reference/use-qwen-by-calling-api)/[cn](https://help.aliyun.com/zh/model-studio/getting-started/models) |
| `mistral` | `MISTRAL_API_KEY` | [docs](https://docs.mistral.ai/getting-started/models/models_overview/) |
| `replicate` | `REPLICATE_API_KEY` | [docs](https://replicate.com/collections/language-models) |
| `groq` (not grok) | `GROQCLOUD_API_KEY` | [docs](https://console.groq.com/docs/models) |
| `huggingface` | `HUGGINGFACE_API_KEY` | [docs](https://huggingface.co/models) |
| `novita` | `NOVITA_API_KEY` | [docs](https://novita.ai/model-api/product/llm-api?utm_source=github_mindcraft&utm_medium=github_readme&utm_campaign=link) |
| `openrouter` | `OPENROUTER_API_KEY` | [docs](https://openrouter.ai/models) |
| `glhf` | `GHLF_API_KEY` | [docs](https://glhf.chat/user-settings/api) |
| `hyperbolic` | `HYPERBOLIC_API_KEY` | [docs](https://docs.hyperbolic.xyz/docs/getting-started) |
| `vllm` | n/a | n/a |
| `cerebras` | `CEREBRAS_API_KEY` | [docs](https://inference-docs.cerebras.ai/introduction) |
| `mercury` | `MERCURY_API_KEY` | [docs](https://www.inceptionlabs.ai/) |

</details>

For more comprehensive model configuration and syntax, see [Model Specifications](#model-specifications).

For local models we support [ollama](https://ollama.com/) and we provide our own finetuned models for you to use. 
To install our models, install ollama and run the following terminal command:
```bash
ollama pull sweaterdog/andy-4:micro-q8_0 && ollama pull embeddinggemma
```

## Online Servers
To connect to online servers your bot will need an official Microsoft/Minecraft account. You can use your own personal one, but will need another account if you want to connect too and play with it. To connect, change these lines in `settings.js`:
```javascript
"host": "111.222.333.444",
"port": 55920,
"auth": "microsoft",

// rest is same...
```
> [!Important]
> The bot's name in the profile.json must exactly match the Minecraft profile name! Otherwise the bot will spam talk to itself.

To use different accounts, Mindcraft will connect with the account that the Minecraft launcher is currently using. You can switch accounts in the launcher, then run `node main.js`, then switch to your main account after the bot has connected.

## Tasks

Tasks automatically start the bot with a prompt and a goal item to aquire or blueprint to construct. To run a simple task that involves collecting 4 oak_logs run 

`node main.js --task_path tasks/basic/single_agent.json --task_id gather_oak_logs`

Here is an example task json format: 

```
{
    "gather_oak_logs": {
      "goal": "Collect at least four logs",
      "initial_inventory": {
        "0": {
          "wooden_axe": 1
        }
      },
      "agent_count": 1,
      "target": "oak_log",
      "number_of_target": 4,
      "type": "techtree",
      "max_depth": 1,
      "depth": 0,
      "timeout": 300,
      "blocked_actions": {
        "0": [],
        "1": []
      },
      "missing_items": [],
      "requires_ctable": false
    }
}
```

The `initial_inventory` is what the bot will have at the start of the episode, `target` refers to the target item and `number_of_target` refers to the number of target items the agent needs to collect to successfully complete the task. 

If you want more optimization and automatic launching of the minecraft world, you will need to follow the instructions in [Minecollab Instructions](minecollab.md#installation)

## Docker Container

If you intend to `allow_insecure_coding`, it is a good idea to run the app in a docker container to reduce risks of running unknown code. This is strongly recommended before connecting to remote servers, although still does not guarantee complete safety.

```bash
docker build -t mindcraft . && docker run --rm --add-host=host.docker.internal:host-gateway -p 8080:8080 -p 12000-12010:12000-12010 -e SETTINGS_JSON='{"auto_open_ui":false,"profiles":["./profiles/gemini.json"],"host":"host.docker.internal"}' --volume ./keys.json:/app/keys.json --name mindcraft mindcraft
```
or simply
```bash
docker-compose up --build
```

When running in docker, if you want the bot to join your local minecraft server, you have to use a special host address `host.docker.internal` to call your localhost from inside your docker container. Put this into your [settings.js](settings.js):

```javascript
"host": "host.docker.internal", // instead of "localhost", to join your local minecraft from inside the docker container
```

To connect to an unsupported minecraft version, you can try to use [viaproxy](services/viaproxy/README.md)

# Bot Profiles

Bot profiles are json files (such as `andy.json`) that define:

1. Bot backend LLMs to use for talking, coding, and embedding.
2. Prompts used to influence the bot's behavior.
3. Examples help the bot perform tasks.

## Model Specifications

LLM models can be specified simply as `"model": "gpt-4o"`, or more specifically with `"{api}/{model}"`, like `"openrouter/google/gemini-2.5-pro"`. See all supported APIs [here](#model-customization).

The `model` field can be a string or an object. A model object must specify an `api`, and optionally a `model`, `url`, and additional `params`. You can also use different models/providers for chatting, coding, vision, embedding, and voice synthesis. See the example below.

```json
"model": {
  "api": "openai",
  "model": "gpt-4o",
  "url": "https://api.openai.com/v1/",
  "params": {
    "max_tokens": 1000,
    "temperature": 1
  }
},
"code_model": {
  "api": "openai",
  "model": "gpt-4",
  "url": "https://api.openai.com/v1/"
},
"vision_model": {
  "api": "openai",
  "model": "gpt-4o",
  "url": "https://api.openai.com/v1/"
},
"embedding": {
  "api": "openai",
  "url": "https://api.openai.com/v1/",
  "model": "text-embedding-ada-002"
},
"speak_model": "openai/tts-1/echo"
```

`model` is used for chat, `code_model` is used for newAction coding, `vision_model` is used for image interpretation, `embedding` is used to embed text for example selection, and `speak_model` is used for voice synthesis. `model` will be used by default for all other models if not specified. Not all APIs support embeddings, vision, or voice synthesis.

All apis have default models and urls, so those fields are optional. The `params` field is optional and can be used to specify additional parameters for the model. It accepts any key-value pairs supported by the api. Is not supported for embedding models.

## Embedding Models

Embedding models are used to embed and efficiently select relevant examples for conversation and coding.

Supported Embedding APIs: `openai`, `google`, `replicate`, `huggingface`, `novita`

If you try to use an unsupported model, then it will default to a simple word-overlap method. Expect reduced performance. We recommend using supported embedding APIs.

## Voice Synthesis Models

Voice synthesis models are used to narrate bot responses and specified with `speak_model`. This field is parsed differently than other models and only supports strings formatted as `"{api}/{model}/{voice}"`, like `"openai/tts-1/echo"`. We only support `openai` and `google` for voice synthesis.

## Specifying Profiles via Command Line

By default, the program will use the profiles specified in `settings.js`. You can specify one or more agent profiles using the `--profiles` argument: `node main.js --profiles ./profiles/andy.json ./profiles/jill.json`


# Contributing

We welcome contributions to the project! We are generally less responsive to github issues, and more responsive to pull requests. Join the [discord](https://discord.gg/mp73p35dzC) for more active support and direction.

While AI generated code is allowed, please vet it carefully. Submitting tons of sloppy code and documentation actively harms development.

## Patches

Some of the node modules that we depend on have bugs in them. To add a patch, change your local node module file and run `npx patch-package [package-name]`

## Development Team
Thanks to all who contributed to the project, especially the official development team: [@MaxRobinsonTheGreat](https://github.com/MaxRobinsonTheGreat), [@kolbytn](https://github.com/kolbytn), [@icwhite](https://github.com/icwhite), [@Sweaterdog](https://github.com/Sweaterdog), [@Ninot1Quyi](https://github.com/Ninot1Quyi), [@riqvip](https://github.com/riqvip), [@uukelele-scratch](https://github.com/uukelele-scratch), [@mrelmida](https://github.com/mrelmida)


## Citation:
This work is published in the paper [Collaborating Action by Action: A Multi-agent LLM Framework for Embodied Reasoning](https://arxiv.org/abs/2504.17950). Please use this citation if you use this project in your research:
```
@article{mindcraft2025,
  title = {Collaborating Action by Action: A Multi-agent LLM Framework for Embodied Reasoning},
  author = {White*, Isadora and Nottingham*, Kolby and Maniar, Ayush and Robinson, Max and Lillemark, Hansen and Maheshwari, Mehul and Qin, Lianhui and Ammanabrolu, Prithviraj},
  journal = {arXiv preprint arXiv:2504.17950},
  year = {2025},
  url = {https://arxiv.org/abs/2504.17950},
}
```
