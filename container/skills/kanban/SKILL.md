# Kanban Board

Each group has an isolated Kanban board. Use these tools to manage tasks visually across columns (e.g. To Do → In Progress → Done).

Your `group_folder` is always your own group's folder name. Never use another group's folder.

## Tools

### `kanban_get_board`
Get the full board — all columns and cards in order.
```
kanban_get_board(group_folder: "mygroup")
```

### `kanban_add_column`
Add a new column at the end of the board.
```
kanban_add_column(group_folder: "mygroup", name: "Review")
```

### `kanban_rename_column`
Rename a column by its ID.
```
kanban_rename_column(group_folder: "mygroup", column_id: "col_abc123", name: "QA")
```

### `kanban_delete_column`
Delete a column. Cards move to the first remaining column. Deleting the last column deletes all cards.
```
kanban_delete_column(group_folder: "mygroup", column_id: "col_abc123")
```

### `kanban_add_card`
Add a card to a column (appended at the bottom).
```
kanban_add_card(group_folder: "mygroup", column_id: "col_abc123", title: "Fix login bug", description: "Users can't log in on mobile")
```

### `kanban_update_card`
Update a card's title and/or description.
```
kanban_update_card(group_folder: "mygroup", card_id: "card_xyz789", title: "Fix login bug (urgent)")
```

### `kanban_move_card`
Move a card to a different column, optionally at a specific position (0 = top).
```
kanban_move_card(group_folder: "mygroup", card_id: "card_xyz789", column_id: "col_def456")
kanban_move_card(group_folder: "mygroup", card_id: "card_xyz789", column_id: "col_def456", position: 0)
```

### `kanban_delete_card`
Delete a card permanently.
```
kanban_delete_card(group_folder: "mygroup", card_id: "card_xyz789")
```

## Default Columns
On first use, the board is seeded with: **To Do**, **In Progress**, **Done**.
