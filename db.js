const path = require('path')
const fs = require('fs')
const sqlite3 = require('sqlite3').verbose()

const dataDir = process.env.RENDER ? '/opt/render/project/src/data' : __dirname

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

const dbPath = path.join(dataDir, 'veo_tasks.db')
const db = new sqlite3.Database(dbPath)

function initDb() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT NOT NULL,
        local_id TEXT,
        api_task_id TEXT,
        prompt TEXT NOT NULL,
        model TEXT NOT NULL,
        aspect_ratio TEXT NOT NULL,
        image_name TEXT,
        status TEXT DEFAULT 'queued',
        progress REAL DEFAULT 0,
        video_url TEXT DEFAULT '',
        error_message TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
  })
}

function createTask(task) {
  return new Promise((resolve, reject) => {
    const sql = `
      INSERT INTO tasks (
        client_id,
        local_id,
        api_task_id,
        prompt,
        model,
        aspect_ratio,
        image_name,
        status,
        progress,
        video_url,
        error_message,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `

    const params = [
      task.clientId,
      task.localId || '',
      task.apiTaskId || '',
      task.prompt,
      task.model,
      task.aspectRatio,
      task.imageName || '',
      task.status || 'queued',
      task.progress || 0,
      task.videoUrl || '',
      task.errorMessage || '',
      task.createdAt,
      task.updatedAt,
    ]

    db.run(sql, params, function (err) {
      if (err) return reject(err)
      resolve({ id: this.lastID })
    })
  })
}

function updateTaskByApiTaskId(apiTaskId, patch) {
  return new Promise((resolve, reject) => {
    const sql = `
      UPDATE tasks
      SET
        status = ?,
        progress = ?,
        video_url = ?,
        error_message = ?,
        updated_at = ?
      WHERE api_task_id = ?
    `

    const params = [
      patch.status || '',
      patch.progress || 0,
      patch.videoUrl || '',
      patch.errorMessage || '',
      patch.updatedAt,
      apiTaskId,
    ]

    db.run(sql, params, function (err) {
      if (err) return reject(err)
      resolve({ changes: this.changes })
    })
  })
}

function bindApiTaskId(dbId, apiTaskId, updatedAt) {
  return new Promise((resolve, reject) => {
    const sql = `
      UPDATE tasks
      SET api_task_id = ?, updated_at = ?
      WHERE id = ?
    `

    db.run(sql, [apiTaskId, updatedAt, dbId], function (err) {
      if (err) return reject(err)
      resolve({ changes: this.changes })
    })
  })
}

function getTasksByClientId(clientId) {
  return new Promise((resolve, reject) => {
    const sql = `
      SELECT *
      FROM tasks
      WHERE client_id = ?
      ORDER BY id DESC
    `

    db.all(sql, [clientId], (err, rows) => {
      if (err) return reject(err)
      resolve(rows)
    })
  })
}

module.exports = {
  db,
  initDb,
  createTask,
  updateTaskByApiTaskId,
  bindApiTaskId,
  getTasksByClientId,
}