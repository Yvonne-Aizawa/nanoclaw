# Telegram Reactions

You can react to Telegram messages using the `react_to_message` tool from the `utils` MCP server.

## Sending a reaction

```
mcp__utils__react_to_message({
  chat_jid: "tg:123456789",       // the chat JID
  message_id: "42",               // the message ID (from conversation history)
  emoji: "👍",                    // any standard Telegram reaction emoji
  group_folder: "my_group"        // your group folder name
})
```

## Removing a reaction

Pass an empty string for `emoji`:

```
mcp__utils__react_to_message({
  chat_jid: "tg:123456789",
  message_id: "42",
  emoji: "",
  group_folder: "my_group"
})
```

## Notes

- Only standard Telegram reaction emojis are supported (e.g. 👍 👎 ❤️ 🔥 🎉 😂 😮 😢 💯 ⭐)
- You can only set one reaction per message
- Reactions from users are stored in the database and visible in chat history as `[Reaction: emoji]`
- Your group folder name is in your CLAUDE.md or visible in the system prompt
