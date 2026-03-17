# Kanban Board

Each group has an isolated Kanban board. Your board is automatically scoped to your group — no group parameter needed.

## Tools

### `kanban_get_board`
Get the full board — all columns and cards in order.
```
kanban_get_board()
```

### `kanban_add_column`
Add a new column at the end of the board.
```
kanban_add_column(name: "Review")
```

### `kanban_rename_column`
Rename a column by its ID.
```
kanban_rename_column(column_id: "col_abc123", name: "QA")
```

### `kanban_delete_column`
Delete a column. Cards move to the first remaining column. Deleting the last column deletes all cards.
```
kanban_delete_column(column_id: "col_abc123")
```

### `kanban_add_card`
Add a card to a column (appended at the bottom). Priority is optional: `high`, `medium`, or `low`.
```
kanban_add_card(column_id: "col_abc123", title: "Fix login bug", description: "Users can't log in on mobile", priority: "high")
```

### `kanban_update_card`
Update a card's title, description, and/or priority. Use `priority: "none"` to clear it.
```
kanban_update_card(card_id: "card_xyz789", priority: "high")
kanban_update_card(card_id: "card_xyz789", title: "Fixed", priority: "none")
```

### `kanban_move_card`
Move a card to a different column, optionally at a specific position (0 = top).
```
kanban_move_card(card_id: "card_xyz789", column_id: "col_def456")
kanban_move_card(card_id: "card_xyz789", column_id: "col_def456", position: 0)
```

### `kanban_delete_card`
Delete a card permanently.
```
kanban_delete_card(card_id: "card_xyz789")
```

## Default Columns
On first use, the board is seeded with: **To Do**, **In Progress**, **Done**.
