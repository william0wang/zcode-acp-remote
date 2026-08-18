# Approval card context comes from the tool_call, matched by toolCallId

`session/request_permission` params carry almost no context the user can act
on: options are bare labels and `toolCall.rawInput` is an opaque
tool-specific object. The plan text (ExitPlanMode) and the question text
(AskUserQuestion) are not in the params at all — the bridge ships them as the
content of a `tool_call` update sent immediately before the request. We
therefore resolve approval context by matching `params.toolCall.toolCallId`
against the message stream, instead of asking the server to fatten the
permission params. Cost: the card must degrade to plain buttons when the
matching tool_call is missing (e.g. it arrived before we attached).
