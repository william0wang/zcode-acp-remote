# assistant-ui + shadcn/ui for the chat UI

We build the chat surface on assistant-ui (the most-adopted dedicated React
AI-chat library, shadcn-style copy-paste components, MIT) plus shadcn/ui for
standard pieces (dialogs, drawers, lists), instead of a general mobile
component library (antd-mobile) or Ant Design X. Streaming, auto-scroll,
markdown/code highlighting, tool-call rendering, and inline human approvals
come from the library; the cost is a custom ACP runtime adapter mapping
`session/update` to assistant-ui's message model — a mapping layer we would
write in some shape regardless of UI choice.
