import { db } from './connection.js';

export interface KanbanColumn {
  id: string;
  group_folder: string;
  name: string;
  position: number;
  created_at: string;
}

export interface KanbanCard {
  id: string;
  group_folder: string;
  column_id: string;
  title: string;
  description: string | null;
  priority: 'high' | 'medium' | 'low' | null;
  deps: string[]; // card IDs this card depends on (is blocked by)
  position: number;
  created_at: string;
  updated_at: string;
}

export interface KanbanBoard {
  columns: Array<KanbanColumn & { cards: KanbanCard[] }>;
}

const DEFAULT_COLUMNS = ['To Do', 'In Progress', 'Done'];

export function getKanbanBoard(groupFolder: string): KanbanBoard {
  // Seed default columns on first access
  const existing = db
    .prepare('SELECT id FROM kanban_columns WHERE group_folder = ? LIMIT 1')
    .get(groupFolder);
  if (!existing) {
    const now = new Date().toISOString();
    for (let i = 0; i < DEFAULT_COLUMNS.length; i++) {
      db.prepare(
        `INSERT INTO kanban_columns (id, group_folder, name, position, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(`${groupFolder}-col-${i}`, groupFolder, DEFAULT_COLUMNS[i], i, now);
    }
  }

  const columns = db
    .prepare(
      `SELECT * FROM kanban_columns WHERE group_folder = ? ORDER BY position`,
    )
    .all(groupFolder) as KanbanColumn[];

  const rawCards = db
    .prepare(
      `SELECT * FROM kanban_cards WHERE group_folder = ? ORDER BY position`,
    )
    .all(groupFolder) as Omit<KanbanCard, 'deps'>[];

  const rawDeps = db
    .prepare(
      `SELECT card_id, depends_on_id FROM kanban_card_deps WHERE group_folder = ?`,
    )
    .all(groupFolder) as { card_id: string; depends_on_id: string }[];

  const depsByCard = new Map<string, string[]>();
  for (const d of rawDeps) {
    if (!depsByCard.has(d.card_id)) depsByCard.set(d.card_id, []);
    depsByCard.get(d.card_id)!.push(d.depends_on_id);
  }

  const cards: KanbanCard[] = rawCards.map((c) => ({
    ...c,
    deps: depsByCard.get(c.id) ?? [],
  }));

  const cardsByColumn = new Map<string, KanbanCard[]>();
  for (const card of cards) {
    if (!cardsByColumn.has(card.column_id))
      cardsByColumn.set(card.column_id, []);
    cardsByColumn.get(card.column_id)!.push(card);
  }

  return {
    columns: columns.map((col) => ({
      ...col,
      cards: cardsByColumn.get(col.id) ?? [],
    })),
  };
}

export function createKanbanColumn(
  groupFolder: string,
  name: string,
): KanbanColumn {
  const id = `${groupFolder}-col-${Date.now()}`;
  const maxPos = (
    db
      .prepare(
        'SELECT MAX(position) as m FROM kanban_columns WHERE group_folder = ?',
      )
      .get(groupFolder) as { m: number | null }
  ).m;
  const position = (maxPos ?? -1) + 1;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO kanban_columns (id, group_folder, name, position, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, groupFolder, name, position, now);
  return { id, group_folder: groupFolder, name, position, created_at: now };
}

export function renameKanbanColumn(
  columnId: string,
  groupFolder: string,
  name: string,
): void {
  db.prepare(
    `UPDATE kanban_columns SET name = ? WHERE id = ? AND group_folder = ?`,
  ).run(name, columnId, groupFolder);
}

export function deleteKanbanColumn(
  columnId: string,
  groupFolder: string,
): void {
  // Move cards to the first remaining column
  const firstOther = db
    .prepare(
      `SELECT id FROM kanban_columns WHERE group_folder = ? AND id != ? ORDER BY position LIMIT 1`,
    )
    .get(groupFolder, columnId) as { id: string } | undefined;

  if (firstOther) {
    const maxPos =
      (
        db
          .prepare(
            'SELECT MAX(position) as m FROM kanban_cards WHERE column_id = ?',
          )
          .get(firstOther.id) as { m: number | null }
      ).m ?? -1;
    const cards = db
      .prepare(
        `SELECT id FROM kanban_cards WHERE column_id = ? ORDER BY position`,
      )
      .all(columnId) as { id: string }[];
    for (let i = 0; i < cards.length; i++) {
      db.prepare(
        `UPDATE kanban_cards SET column_id = ?, position = ?, updated_at = ? WHERE id = ?`,
      ).run(
        firstOther.id,
        maxPos + 1 + i,
        new Date().toISOString(),
        cards[i].id,
      );
    }
  } else {
    // No other column — delete cards
    db.prepare(`DELETE FROM kanban_cards WHERE column_id = ?`).run(columnId);
  }

  db.prepare(
    `DELETE FROM kanban_columns WHERE id = ? AND group_folder = ?`,
  ).run(columnId, groupFolder);
}

export function addKanbanCard(
  groupFolder: string,
  columnId: string,
  title: string,
  description?: string,
  priority?: 'high' | 'medium' | 'low',
): KanbanCard {
  const id = `card-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const maxPos = (
    db
      .prepare(
        'SELECT MAX(position) as m FROM kanban_cards WHERE column_id = ?',
      )
      .get(columnId) as { m: number | null }
  ).m;
  const position = (maxPos ?? -1) + 1;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO kanban_cards (id, group_folder, column_id, title, description, priority, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    groupFolder,
    columnId,
    title,
    description ?? null,
    priority ?? null,
    position,
    now,
    now,
  );
  return {
    id,
    group_folder: groupFolder,
    column_id: columnId,
    title,
    description: description ?? null,
    priority: priority ?? null,
    deps: [],
    position,
    created_at: now,
    updated_at: now,
  };
}

export function updateKanbanCard(
  cardId: string,
  groupFolder: string,
  title?: string,
  description?: string,
  priority?: 'high' | 'medium' | 'low' | null,
): void {
  const now = new Date().toISOString();
  const fields: string[] = [];
  const values: unknown[] = [];
  if (title !== undefined) {
    fields.push('title = ?');
    values.push(title);
  }
  if (description !== undefined) {
    fields.push('description = ?');
    values.push(description);
  }
  if (priority !== undefined) {
    fields.push('priority = ?');
    values.push(priority);
  }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(now, cardId, groupFolder);
  db.prepare(
    `UPDATE kanban_cards SET ${fields.join(', ')} WHERE id = ? AND group_folder = ?`,
  ).run(...values);
}

export function moveKanbanCard(
  cardId: string,
  groupFolder: string,
  columnId: string,
  position?: number,
): void {
  const now = new Date().toISOString();
  if (position === undefined) {
    const maxPos = (
      db
        .prepare(
          'SELECT MAX(position) as m FROM kanban_cards WHERE column_id = ?',
        )
        .get(columnId) as { m: number | null }
    ).m;
    position = (maxPos ?? -1) + 1;
  }
  db.prepare(
    `UPDATE kanban_cards SET column_id = ?, position = ?, updated_at = ? WHERE id = ? AND group_folder = ?`,
  ).run(columnId, position, now, cardId, groupFolder);
}

export function deleteKanbanCard(cardId: string, groupFolder: string): void {
  db.prepare(
    `DELETE FROM kanban_card_deps WHERE (card_id = ? OR depends_on_id = ?) AND group_folder = ?`,
  ).run(cardId, cardId, groupFolder);
  db.prepare(`DELETE FROM kanban_cards WHERE id = ? AND group_folder = ?`).run(
    cardId,
    groupFolder,
  );
}

export function addKanbanCardDep(
  cardId: string,
  dependsOnId: string,
  groupFolder: string,
): void {
  if (cardId === dependsOnId) throw new Error('A card cannot depend on itself');
  const cardOk = db
    .prepare(`SELECT id FROM kanban_cards WHERE id = ? AND group_folder = ?`)
    .get(cardId, groupFolder);
  const depOk = db
    .prepare(`SELECT id FROM kanban_cards WHERE id = ? AND group_folder = ?`)
    .get(dependsOnId, groupFolder);
  if (!cardOk || !depOk) throw new Error('Card not found in group');
  db.prepare(
    `INSERT OR IGNORE INTO kanban_card_deps (card_id, depends_on_id, group_folder) VALUES (?, ?, ?)`,
  ).run(cardId, dependsOnId, groupFolder);
}

export function removeKanbanCardDep(
  cardId: string,
  dependsOnId: string,
  groupFolder: string,
): void {
  db.prepare(
    `DELETE FROM kanban_card_deps WHERE card_id = ? AND depends_on_id = ? AND group_folder = ?`,
  ).run(cardId, dependsOnId, groupFolder);
}
