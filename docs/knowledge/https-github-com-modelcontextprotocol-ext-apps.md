---
type: learning
title: "https://github.com/modelcontextprotocol/ext-apps"
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-07-30
lastVerifiedAt: 2026-07-30
---

https://github.com/modelcontextprotocol/ext-apps
Build with Agent Skills
The fastest way to build an MCP App is to let your AI coding agent do it. This repo ships four Agent Skills — install them once, then just ask:

Skill	What it does	Try it
create-mcp-app	Scaffolds a new MCP App with an interactive UI from scratch	"Create an MCP App"
migrate-oai-app	Converts an existing OpenAI App to use MCP Apps	"Migrate from OpenAI Apps SDK"
add-app-to-server	Adds interactive UI to an existing MCP server's tools	"Add UI to my MCP server"
convert-web-app	Turns an existing web app into a hybrid web + MCP App	"Add MCP App support to my web app"
Install the Skills
Claude Code — install via the plugin marketplace:

/plugin marketplace add modelcontextprotocol/ext-apps
/plugin install mcp-apps@modelcontextprotocol-ext-apps
Other agents — any AI coding agent that supports Agent Skills can use these skills. See the agent skills guide for manual installation instructions.

Once installed, verify by asking your agent "What skills do you have?" — you should see create-mcp-app, migrate-oai-app, add-app-to-server, and convert-web-app in the list. Then just ask it to create or migrate an app and it will guide you through the rest.

Source: https://github.com/modelcontextprotocol/ext-apps
