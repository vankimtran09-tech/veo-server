const express = require('express')
const cors = require('cors')
const dotenv = require('dotenv')
const multer = require('multer')
const axios = require('axios')
const FormData = require('form-data')
const {
  initDb,
  createTask,
  updateTaskByApiTaskId,
  bindApiTaskId,
  getTasksByClientId,
} = require('./db')

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3001

const upload = multer({ storage: multer.memoryStorage() })

app.use(cors())
app.use(express.json())

initDb()

function mapAspectRatioToSize(aspectRatio) {
  if (aspectRatio === '16:9') return '16x9'
  if (aspectRatio === '9:16') return '9x16'
  return '16x9'
}

function nowString() {
  return new Date().toISOString()
}

function normalizeStatusResponse(data) {
  const topLevelStatus = data?.status || ''
  const detailStatus = data?.detail?.status || ''
  const pendingInfoStatus = data?.detail?.pending_info?.status || ''

  const finalStatus = topLevelStatus || detailStatus || pendingInfoStatus || 'unknown'

  const progress =
    data?.progress ??
    data?.detail?.pending_info?.progress_pct ??
    0

  const videoUrl = data?.video_url || ''

  let errorMessage = ''
  if (typeof data?.error === 'string') errorMessage = data.error
  else if (data?.error?.message) errorMessage = data.error.message
  else if (data?.detail?.pending_info?.failure_reason) {
    errorMessage = data.detail.pending_info.failure_reason
  }

  return {
    success: true,
    id: data?.id || '',
    status: finalStatus,
    progress,
    videoUrl,
    error: errorMessage,
    raw: data,
  }
}

app.get('/', (req, res) => {
  res.json({
    message: 'Veo 后端服务已启动',
    status: 'ok',
  })
})

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: '服务运行正常',
    port: PORT,
  })
})

app.get('/api/tasks', async (req, res) => {
  try {
    const { clientId } = req.query

    if (!clientId) {
      return res.status(400).json({
        success: false,
        error: 'clientId 不能为空',
      })
    }

    const rows = await getTasksByClientId(clientId)

    const tasks = rows.map((row) => ({
      dbId: row.id,
      localId: row.local_id,
      apiId: row.api_task_id || '',
      prompt: row.prompt,
      model: row.model,
      aspectRatio: row.aspect_ratio,
      imageName: row.image_name || '',
      status: row.status,
      progress:
        typeof row.progress === 'number'
          ? row.progress > 1 && row.progress <= 100
            ? row.progress
            : Math.round(row.progress * 100)
          : 0,
      videoUrl: row.video_url || '',
      error: row.error_message || '',
      retryHint: '',
      createdAt: row.created_at,
      isRetrying: false,
      canRetryAfterRefresh: false,
    }))

    return res.json({
      success: true,
      tasks,
    })
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: '获取任务列表失败',
      detail: error.message,
    })
  }
})

app.post('/api/videos', upload.single('image'), async (req, res) => {
  try {
    const { prompt, model, aspectRatio, clientId, localId } = req.body
    const image = req.file
    const token = process.env.VECTOR_API_TOKEN

    if (!token) {
      return res.status(500).json({
        success: false,
        error: '未配置 VECTOR_API_TOKEN',
      })
    }

    if (!clientId) {
      return res.status(400).json({
        success: false,
        error: 'clientId 不能为空',
      })
    }

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({
        success: false,
        error: '提示词不能为空',
      })
    }

    if (!model) {
      return res.status(400).json({
        success: false,
        error: '模型不能为空',
      })
    }

    if (!aspectRatio) {
      return res.status(400).json({
        success: false,
        error: '画面比例不能为空',
      })
    }

    if (!image) {
      return res.status(400).json({
        success: false,
        error: '必须上传 1 张参考图',
      })
    }

    const createdAt = nowString()

    const inserted = await createTask({
      clientId,
      localId,
      apiTaskId: '',
      prompt,
      model,
      aspectRatio,
      imageName: image.originalname,
      status: 'creating',
      progress: 0,
      videoUrl: '',
      errorMessage: '',
      createdAt,
      updatedAt: createdAt,
    })

    const size = mapAspectRatioToSize(aspectRatio)

    const form = new FormData()
    form.append('model', model)
    form.append('prompt', prompt)
    form.append('seconds', '8')
    form.append('size', size)
    form.append('watermark', 'false')
    form.append('input_reference', image.buffer, {
      filename: image.originalname,
      contentType: image.mimetype,
    })

    const response = await axios.post(
      'https://api.vectorengine.ai/v1/videos',
      form,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...form.getHeaders(),
        },
        maxBodyLength: Infinity,
      }
    )

    const data = response.data || {}
    const updatedAt = nowString()

    if (data.id) {
      await bindApiTaskId(inserted.id, data.id, updatedAt)

      await updateTaskByApiTaskId(data.id, {
        status: data.status || 'queued',
        progress: data.progress ?? 0,
        videoUrl: data.video_url || '',
        errorMessage: '',
        updatedAt,
      })
    }

    return res.json({
      success: true,
      dbId: inserted.id,
      id: data.id || '',
      status: data.status || '',
      progress: data.progress ?? 0,
      raw: data,
    })
  } catch (error) {
    const apiError = error.response?.data

    return res.status(error.response?.status || 500).json({
      success: false,
      error: '创建视频任务失败',
      detail: apiError || error.message,
    })
  }
})

app.get('/api/videos/:id', async (req, res) => {
  try {
    const { id } = req.params
    const token = process.env.VECTOR_API_TOKEN

    if (!token) {
      return res.status(500).json({
        success: false,
        error: '未配置 VECTOR_API_TOKEN',
      })
    }

    if (!id) {
      return res.status(400).json({
        success: false,
        error: '任务 ID 不能为空',
      })
    }

    const response = await axios.get(
      `https://api.vectorengine.ai/v1/videos/${id}`,
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      }
    )

    const data = response.data || {}
    const normalized = normalizeStatusResponse(data)

    await updateTaskByApiTaskId(id, {
      status: normalized.status,
      progress: normalized.progress,
      videoUrl: normalized.videoUrl,
      errorMessage: normalized.error,
      updatedAt: nowString(),
    })

    return res.json(normalized)
  } catch (error) {
    const apiError = error.response?.data

    let errorMessage = '查询视频任务失败'
    if (typeof apiError?.error === 'string') errorMessage = apiError.error
    else if (apiError?.error?.message) errorMessage = apiError.error.message

    try {
      await updateTaskByApiTaskId(req.params.id, {
        status: 'failed',
        progress: 0,
        videoUrl: '',
        errorMessage,
        updatedAt: nowString(),
      })
    } catch {}

    return res.status(error.response?.status || 500).json({
      success: false,
      error: '查询视频任务失败',
      detail: apiError || error.message,
    })
  }
})

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`)
})