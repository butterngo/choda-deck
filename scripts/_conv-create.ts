import { SqliteTaskService } from '../src/tasks/sqlite-task-service'

const DB_PATH = process.env.CHODA_DB_PATH || 'C:\\dev\\choda-deck\\choda-deck.db'
const svc = new SqliteTaskService(DB_PATH)

const conv = svc.createConversation({
  projectId: 'automation-rule',
  title: 'task_list không hiển thị TODO tasks khi không filter — vault sync gap',
  createdBy: 'Butter',
  status: 'open',
  participants: [
    { name: 'Butter', type: 'human' },
    { name: 'Claude', type: 'agent' }
  ]
})

svc.addConversationMessage({
  conversationId: conv.id,
  authorName: 'Butter',
  content:
    'Chạy task_list từ choda-tasks MCP không thấy TASK-157, 159, 161, 162, 138, 141, 134 — cả TODO lẫn DONE đều không có. Những task này chỉ tồn tại trong daily note.',
  messageType: 'question'
})

svc.addConversationMessage({
  conversationId: conv.id,
  authorName: 'Claude',
  content:
    '7 task đó thực ra có trong DB với status TODO. Root cause: (1) import script lỗi path escaping (backslash) nên lần đầu import không chạy, (2) extractId regex chỉ match TASK-\\d+ nên timestamp IDs bị truncated tạo ghost records. Đã fix cả 2 và re-import. task_list không filter sẽ thấy đủ 29 TODO tasks.',
  messageType: 'answer'
})

console.log('Created conversation:', JSON.stringify(conv, null, 2))
svc.close()
