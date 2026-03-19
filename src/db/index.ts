export { db, initDatabase, _initTestDatabase } from './connection.js';
export type {} from './connection.js';

export {
  storeChatMetadata,
  updateChatName,
  getAllChats,
  getLastGroupSync,
  setLastGroupSync,
  storeMessage,
  storeMessageDirect,
  getNewMessages,
  getMessagesSince,
} from './messages.js';
export type { ChatInfo } from './messages.js';

export { getSession, setSession, getAllSessions } from './sessions.js';

export {
  createTask,
  getTaskById,
  getTasksForGroup,
  getAllTasks,
  updateTask,
  deleteTask,
  getDueTasks,
  updateTaskAfterRun,
  logTaskRun,
} from './tasks.js';

export {
  getKanbanBoard,
  createKanbanColumn,
  renameKanbanColumn,
  deleteKanbanColumn,
  addKanbanCard,
  updateKanbanCard,
  moveKanbanCard,
  deleteKanbanCard,
  addKanbanCardDep,
  removeKanbanCardDep,
} from './kanban.js';
export type { KanbanColumn, KanbanCard, KanbanBoard } from './kanban.js';

export { upsertReaction, getReactions } from './reactions.js';

export {
  getRouterState,
  setRouterState,
  getRegisteredGroup,
  setRegisteredGroup,
  getAllRegisteredGroups,
} from './groups.js';
