import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { HeaderRefreshButton } from '@/components/HeaderRefreshButton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import {
  ArrowLeft,
  Baby,
  Check,
  GraduationCap,
  Loader2,
  Pencil,
  Plus,
  Smartphone,
  Trash2,
  X,
} from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import type { Child, ChildTask, Device } from '@/types'
import { useTranslation } from 'react-i18next'

/**
 * 孩子档案与今日任务（规划 §5.2）。
 *
 * 在此之前系统里只有「设备」，没有「孩子」：双胞胎的两台手机在系统里毫无关联，
 * 年龄也只在家长的脑子里。这一页把「孩子」补成一个真实的实体，并让它承担
 * 一件家长每天都要做的事 —— 布置今天的任务、看孩子做没做完。
 *
 * 五条刻意的设计：
 *  1. **档案属于家长账号，不属于设备**。所以这一页不要求「当前设备」，
 *     一个还没绑设备的家长也能先把孩子建起来。
 *  2. **年龄由出生年份现算**。存年龄每年都会过期一次，存储的年龄迟早会骗人。
 *  3. **设备归属是整组替换**（界面上就是勾选框）：勾掉即摘除，不需要第二个请求。
 *  4. **删档案不删设备**，弹窗里把这句话写明白 —— 家长最怕的是「整理一下，
 *     孩子的手机没了」。
 *  5. **档案只有自己看得见**。被邀请来看设备的家庭成员（§5.1）看不到别人家孩子的
 *     档案（服务端对越权一律 404）；这一页也不做「切到别人家孩子」这种入口。
 */

const BIRTH_YEAR_MIN = 1990

export function ChildrenPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [children, setChildren] = useState<Child[]>([])
  const [tasks, setTasks] = useState<Record<string, ChildTask[]>>({})
  const [loading, setLoading] = useState(true)

  const [editing, setEditing] = useState<Child | null>(null)
  const [creating, setCreating] = useState(false)
  const [formName, setFormName] = useState('')
  const [formYear, setFormYear] = useState('')
  const [formSchool, setFormSchool] = useState('')
  const [saving, setSaving] = useState(false)

  const [removing, setRemoving] = useState<Child | null>(null)

  const [deviceTarget, setDeviceTarget] = useState<Child | null>(null)
  const [allDevices, setAllDevices] = useState<Device[]>([])
  const [pickedDeviceIds, setPickedDeviceIds] = useState<string[]>([])
  const [deviceBusy, setDeviceBusy] = useState(false)

  /** 每个孩子的「新任务」输入框内容（各存各的，避免打字串台） */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [taskBusy, setTaskBusy] = useState<string | null>(null)

  const load = useCallback(
    () =>
      api
        .getChildren()
        .then(async (res) => {
          setChildren(res.children)
          // 每个孩子的今日任务各拉一次。用 Promise.all 并发，且**失败不整体失败**：
          // 一个孩子的任务拉不到，不该让整页档案都显示不出来。
          const pairs = await Promise.all(
            res.children.map((child) =>
              api
                .getChildTasks(child.id)
                .then((r) => [child.id, r.tasks] as const)
                .catch(() => [child.id, [] as ChildTask[]] as const),
            ),
          )
          setTasks(Object.fromEntries(pairs))
          return res
        })
        .catch((error: unknown) => {
          toast.error(toUserMessage(error, t('加载孩子档案失败')))
        })
        .finally(() => setLoading(false)),
    [t],
  )

  useEffect(() => {
    void load()
  }, [load])

  const openCreate = () => {
    setFormName('')
    setFormYear('')
    setFormSchool('')
    setCreating(true)
  }

  const openEdit = (child: Child) => {
    setFormName(child.name)
    setFormYear(child.birthYear ? String(child.birthYear) : '')
    setFormSchool(child.school)
    setEditing(child)
  }

  const handleSave = async () => {
    const name = formName.trim()
    if (!name) {
      toast.error(t('请填写孩子的称呼'))
      return
    }
    const year = formYear.trim() ? Number(formYear.trim()) : undefined
    setSaving(true)
    try {
      if (editing) {
        await api.updateChild(editing.id, { name, birthYear: year, school: formSchool.trim() })
        toast.success(t('已保存'))
        setEditing(null)
      } else {
        await api.createChild({ name, birthYear: year, school: formSchool.trim() })
        toast.success(t('孩子档案已创建'))
        setCreating(false)
      }
      await load()
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('保存失败，请稍后重试')))
      console.error('保存孩子档案失败：', error)
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async () => {
    if (!removing) return
    const target = removing
    setSaving(true)
    try {
      await api.deleteChild(target.id)
      toast.success(t('档案已删除，设备只是解绑'))
      setRemoving(null)
      await load()
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('删除失败，请稍后重试')))
      console.error('删除孩子档案失败：', error)
    } finally {
      setSaving(false)
    }
  }

  const openDevices = async (child: Child) => {
    setDeviceTarget(child)
    setPickedDeviceIds(child.devices.map((d) => d.id))
    try {
      const res = await api.getDevices()
      setAllDevices(res.devices ?? [])
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('加载设备列表失败')))
    }
  }

  const togglePicked = (deviceId: string) => {
    setPickedDeviceIds((prev) =>
      prev.includes(deviceId) ? prev.filter((id) => id !== deviceId) : [...prev, deviceId],
    )
  }

  const handleSaveDevices = async () => {
    if (!deviceTarget) return
    setDeviceBusy(true)
    try {
      await api.setChildDevices(deviceTarget.id, pickedDeviceIds)
      toast.success(t('已更新设备归属'))
      setDeviceTarget(null)
      await load()
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('保存设备归属失败')))
      console.error('保存设备归属失败：', error)
    } finally {
      setDeviceBusy(false)
    }
  }

  const handleAddTask = async (child: Child) => {
    const title = (drafts[child.id] ?? '').trim()
    if (!title) {
      toast.error(t('请填写任务内容'))
      return
    }
    setTaskBusy(child.id)
    try {
      await api.createChildTask(child.id, { title })
      setDrafts((prev) => ({ ...prev, [child.id]: '' }))
      await load()
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('添加任务失败')))
      console.error('添加任务失败：', error)
    } finally {
      setTaskBusy(null)
    }
  }

  const handleToggleTask = async (child: Child, task: ChildTask) => {
    setTaskBusy(task.id)
    try {
      await api.updateChildTask(child.id, task.id, { done: !task.done })
      await load()
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('更新任务失败')))
      console.error('更新任务失败：', error)
    } finally {
      setTaskBusy(null)
    }
  }

  const handleRemoveTask = async (child: Child, task: ChildTask) => {
    setTaskBusy(task.id)
    try {
      await api.deleteChildTask(child.id, task.id)
      await load()
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('删除任务失败')))
      console.error('删除任务失败：', error)
    } finally {
      setTaskBusy(null)
    }
  }

  return (
    <div className="page-shell">
      <div className="page-header">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center space-x-2">
            <button
              type="button"
              className="p-1 -ml-1 rounded-full hover:bg-gray-100 active:bg-gray-200"
              onClick={() => navigate(-1)}
              aria-label={t('返回')}
            >
              <ArrowLeft className="w-5 h-5 text-gray-700" />
            </button>
            <h1 className="text-base font-medium text-gray-900">{t('孩子档案')}</h1>
          </div>
          <div className="flex items-center space-x-1">
            <button
              type="button"
              className="p-1 rounded-full hover:bg-gray-100 active:bg-gray-200"
              onClick={openCreate}
              aria-label={t('添加孩子')}
            >
              <Plus className="w-5 h-5 text-gray-700" />
            </button>
            <HeaderRefreshButton onRefresh={() => void load()} />
          </div>
        </div>
      </div>

      <div className="px-4 py-4 space-y-3">
        {/* 说明放在最上面：这一页解决的问题（「孩子」这个实体）不是自明的 */}
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-gray-500 leading-relaxed">
              {t(
                '一个孩子可以有多台设备（手机、平板），任务与进度跟着孩子走，不跟着设备走。档案只有你自己能看到 —— 被邀请一起看设备的家人看不到。',
              )}
            </p>
          </CardContent>
        </Card>

        {loading ? (
          <div className="py-10 text-center text-gray-500 text-sm">{t('加载中...')}</div>
        ) : children.length === 0 ? (
          <div className="py-10 text-center">
            <Baby className="w-10 h-10 mx-auto text-gray-300" />
            <p className="mt-2 text-sm text-gray-500">{t('还没有孩子档案')}</p>
            <p className="mt-1 text-xs text-gray-400">
              {t('建一份档案，就能按孩子看设备、布置今天的任务')}
            </p>
            <Button className="mt-3 bg-[#07c160] hover:bg-[#06ad56]" onClick={openCreate}>
              <Plus className="w-4 h-4 mr-1" />
              {t('添加孩子')}
            </Button>
          </div>
        ) : (
          children.map((child) => {
            const childTasks = tasks[child.id] ?? []
            const { total, done } = child.todayTasks
            return (
              <Card key={child.id}>
                <CardContent className="p-4">
                  <div className="flex items-start space-x-3">
                    <div className="w-11 h-11 rounded-full bg-[#07c160]/10 flex items-center justify-center flex-shrink-0">
                      <span className="text-[#07c160] font-medium">{child.name.slice(0, 1)}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center space-x-2">
                        <h2 className="text-sm font-medium text-gray-900 truncate">{child.name}</h2>
                        {child.age != null ? (
                          <Badge variant="secondary" className="text-[10px]">
                            {t('{{v0}} 岁', { v0: child.age })}
                          </Badge>
                        ) : (
                          <span className="text-[10px] text-gray-400">{t('未填出生年份')}</span>
                        )}
                      </div>
                      {child.school ? (
                        <p className="mt-0.5 text-xs text-gray-500 flex items-center">
                          <GraduationCap className="w-3.5 h-3.5 mr-1" />
                          {child.school}
                        </p>
                      ) : null}
                      {/* 设备归属：一眼看到「这个孩子现在有哪些设备」 */}
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {child.devices.length === 0 ? (
                          <span className="text-[10px] text-gray-400">{t('还没有设备')}</span>
                        ) : (
                          child.devices.map((d) => (
                            <span
                              key={d.id}
                              className="inline-flex items-center text-[10px] text-gray-600 bg-gray-100 rounded px-1.5 py-0.5"
                            >
                              <Smartphone className="w-3 h-3 mr-1" />
                              {d.name}
                            </span>
                          ))
                        )}
                        <button
                          type="button"
                          className="text-[10px] text-[#07c160] px-1.5 py-0.5 rounded hover:bg-[#07c160]/10"
                          onClick={() => void openDevices(child)}
                        >
                          {t('管理设备')}
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center space-x-1 flex-shrink-0">
                      <button
                        type="button"
                        className="p-1 rounded-full hover:bg-gray-100"
                        onClick={() => openEdit(child)}
                        aria-label={t('编辑档案')}
                      >
                        <Pencil className="w-4 h-4 text-gray-500" />
                      </button>
                      <button
                        type="button"
                        className="p-1 rounded-full hover:bg-gray-100"
                        onClick={() => setRemoving(child)}
                        aria-label={t('删除档案')}
                      >
                        <Trash2 className="w-4 h-4 text-gray-400" />
                      </button>
                    </div>
                  </div>

                  {/* 今日任务 */}
                  <div className="mt-3 pt-3 border-t border-gray-100">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-gray-700">{t('今日任务')}</span>
                      {total > 0 ? (
                        <span className="text-[10px] text-gray-500">
                          {t('已完成 {{v0}}/{{v1}}', { v0: done, v1: total })}
                        </span>
                      ) : null}
                    </div>
                    {total > 0 ? (
                      <div className="mt-1.5 h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-[#07c160] transition-all"
                          style={{ width: `${Math.round((done / total) * 100)}%` }}
                        />
                      </div>
                    ) : null}

                    <div className="mt-2 space-y-1.5">
                      {childTasks.map((task) => (
                        <div key={task.id} className="flex items-center space-x-2">
                          <button
                            type="button"
                            className={`w-5 h-5 rounded-full border flex items-center justify-center flex-shrink-0 ${
                              task.done
                                ? 'bg-[#07c160] border-[#07c160]'
                                : 'border-gray-300 hover:border-[#07c160]'
                            }`}
                            onClick={() => void handleToggleTask(child, task)}
                            disabled={taskBusy === task.id}
                            aria-label={task.done ? t('标记未完成') : t('标记完成')}
                          >
                            {taskBusy === task.id ? (
                              <Loader2 className="w-3 h-3 text-gray-400 animate-spin" />
                            ) : task.done ? (
                              <Check className="w-3 h-3 text-white" />
                            ) : null}
                          </button>
                          <span
                            className={`flex-1 text-xs ${
                              task.done ? 'text-gray-400 line-through' : 'text-gray-700'
                            }`}
                          >
                            {task.title}
                          </span>
                          <button
                            type="button"
                            className="p-0.5 rounded-full hover:bg-gray-100"
                            onClick={() => void handleRemoveTask(child, task)}
                            disabled={taskBusy === task.id}
                            aria-label={t('删除任务')}
                          >
                            <X className="w-3.5 h-3.5 text-gray-300" />
                          </button>
                        </div>
                      ))}
                      {childTasks.length === 0 ? (
                        <p className="text-[10px] text-gray-400">{t('今天还没有任务')}</p>
                      ) : null}
                    </div>

                    <div className="mt-2 flex items-center space-x-2">
                      <input
                        className="flex-1 px-3 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:border-[#07c160]"
                        placeholder={t('例如：练琴 30 分钟')}
                        value={drafts[child.id] ?? ''}
                        maxLength={50}
                        onChange={(e) =>
                          setDrafts((prev) => ({ ...prev, [child.id]: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleAddTask(child)
                        }}
                      />
                      <Button
                        size="sm"
                        className="bg-[#07c160] hover:bg-[#06ad56] h-7 px-2 text-xs"
                        onClick={() => void handleAddTask(child)}
                        disabled={taskBusy === child.id}
                      >
                        {taskBusy === child.id ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          t('添加')
                        )}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })
        )}
      </div>

      {/* 新建 / 编辑档案 */}
      <Dialog
        open={creating || Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false)
            setEditing(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t('编辑档案') : t('添加孩子')}</DialogTitle>
            <DialogDescription>
              {t('出生年份只填年份，年龄会跟着时间自己走，不用每年改。')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-600">{t('称呼')}</label>
              <input
                className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#07c160]"
                placeholder={t('例如：小明')}
                value={formName}
                maxLength={20}
                onChange={(e) => setFormName(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-gray-600">{t('出生年份（可跳过）')}</label>
              <input
                className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#07c160]"
                placeholder={t('例如：{{v0}}', { v0: new Date().getFullYear() - 9 })}
                inputMode="numeric"
                value={formYear}
                onChange={(e) => setFormYear(e.target.value.replace(/[^\d]/g, '').slice(0, 4))}
              />
              <p className="mt-1 text-[10px] text-gray-400">
                {t('看起来不对的年份会被服务端拒绝（{{v0}} 年之后、今年以前）', {
                  v0: BIRTH_YEAR_MIN,
                })}
              </p>
            </div>
            <div>
              <label className="text-xs text-gray-600">{t('学校（可跳过）')}</label>
              <input
                className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#07c160]"
                placeholder={t('例如：实验小学')}
                value={formSchool}
                maxLength={40}
                onChange={(e) => setFormSchool(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreating(false)
                setEditing(null)
              }}
              disabled={saving}
            >
              {t('取消')}
            </Button>
            <Button className="bg-[#07c160] hover:bg-[#06ad56]" onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              {t('保存')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除档案：把「设备只是解绑」写明白 */}
      <Dialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('删除「{{v0}}」的档案？', { v0: removing?.name ?? '' })}</DialogTitle>
            <DialogDescription>
              {t('档案下的设备不会被删除，只是解绑 —— 设备还会在你的设备列表里。今天的任务记录会一起删掉。')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)} disabled={saving}>
              {t('取消')}
            </Button>
            <Button variant="destructive" onClick={handleRemove} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              {t('确认删除')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 设备归属：勾选框就是「整组替换」，取消勾选即摘除 */}
      <Dialog open={Boolean(deviceTarget)} onOpenChange={(open) => !open && setDeviceTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('「{{v0}}」的设备', { v0: deviceTarget?.name ?? '' })}
            </DialogTitle>
            <DialogDescription>
              {t('勾选属于这个孩子的设备。一台设备只能属于一个孩子，勾到别处会自动从原来那里移走。')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {allDevices.length === 0 ? (
              <p className="py-4 text-center text-xs text-gray-500">
                {t('你还没有绑定设备，先在「设备管理」里绑定一台')}
              </p>
            ) : (
              allDevices.map((device) => {
                const picked = pickedDeviceIds.includes(device.id)
                return (
                  <button
                    key={device.id}
                    type="button"
                    className={`w-full flex items-center space-x-2 px-3 py-2 rounded-lg border text-left ${
                      picked ? 'border-[#07c160] bg-[#07c160]/5' : 'border-gray-200 hover:bg-gray-50'
                    }`}
                    onClick={() => togglePicked(device.id)}
                  >
                    <span
                      className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                        picked ? 'bg-[#07c160] border-[#07c160]' : 'border-gray-300'
                      }`}
                    >
                      {picked ? <Check className="w-3 h-3 text-white" /> : null}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs text-gray-800 truncate">{device.name}</span>
                      <span className="block text-[10px] text-gray-400 truncate">
                        {device.model}
                      </span>
                    </span>
                  </button>
                )
              })
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeviceTarget(null)} disabled={deviceBusy}>
              {t('取消')}
            </Button>
            <Button
              className="bg-[#07c160] hover:bg-[#06ad56]"
              onClick={handleSaveDevices}
              disabled={deviceBusy}
            >
              {deviceBusy ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              {t('保存')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
