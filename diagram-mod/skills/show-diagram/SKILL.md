---
name: show-diagram
description: Draw an animated diagram in a terminal pane with the show_diagram tool. Use when the user asks for a diagram, a flow, an architecture sketch or a visual explanation of how something works.
---

# show_diagram

Call the `show_diagram` tool (from this mod) when the user asks for a diagram, a picture of a flow, or a visual explanation. Do not draw ASCII art in the reply when this tool is available.

## When to call it

- The user says "diagram", "draw", "visualise", "show me how X flows", or asks how parts of a system connect.
- The answer is a set of components and the things that pass between them.
- Do not call it for lists, comparisons or step-by-step text that has no connections.

## Writing a good spec

- **One idea per diagram.** If the explanation has two parts, make two calls, one after the other.
- **At most about 12 nodes.** The tool refuses more than 24.
- **Short labels.** Use 1-3 words, for example `Dispatcher` and not `The dispatcher service that splits tasks`. Put extra facts in `detail`, at most 4 short lines.
- **`status`** is one short state word or phrase: `running`, `3 jobs`, `failed`.
- **Edges** point the way data or control flows. Give an edge a `label` only when the arrow alone is unclear. Edges are dashed by default; set `dashed: false` for a hard dependency.
- **Packets** show traffic. Name the edge by its id, `from->to` (or the `id` you gave the edge). Use 1 packet per active edge. Use `speed` from 0 to 1 to show slower paths.
- **Colors** group nodes by role, not one color per node. Names: blue, green, yellow, red, magenta, cyan, orange, gray, or `#rrggbb`.
- **`log`** holds 2-5 lines that tell the story in order. They type out under the diagram.
- Do not give coordinates. The layout is top to bottom, computed from the edges.

## Example

```json
{
  "title": "Request path",
  "nodes": [
    { "id": "client", "label": "Client", "color": "blue" },
    { "id": "alb", "label": "Load balancer", "color": "magenta" },
    { "id": "app", "label": "App", "detail": ["ECS service"], "color": "green", "status": "2 tasks" }
  ],
  "edges": [{ "from": "client", "to": "alb", "label": "HTTPS" }, { "from": "alb", "to": "app" }],
  "packets": [{ "edge": "client->alb" }, { "edge": "alb->app", "speed": 0.6 }],
  "log": ["client sends GET /", "load balancer forwards to a healthy task"]
}
```

## After the call

- By default (`display: inline`) the diagram animates in the tool's own transcript row. Do not paste the static version from the result; add 1-3 sentences that explain the diagram instead of describing every box.
- With `display: pane` the result says the diagram is in the pane. If it says the terminal is too narrow, paste the static version it holds into your reply in a code fence.
- If the call is refused, fix what the message names (unknown node, repeated id, too many nodes) and call again.
