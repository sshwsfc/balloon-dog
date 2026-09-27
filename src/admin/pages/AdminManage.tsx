import { useState } from 'react'
import { toast } from 'sonner'
import { KeyRound, Loader2, Plus, RefreshCw, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { api, errorMessageOf, formatDateTime, type AdminAccount } from '../api'
import { useAsyncData } from '../hooks/useAsyncData'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { DataState, PageHeader, ToneBadge } from '../components/ui-kit'
import { useAdminAuth } from '../context/AdminAuthContext'

export default function AdminManagePage() {
  const { admin: me } = useAdminAuth()
  const { data: listData, loading, error, reload: load } = useAsyncData(() => api.admins.list(), {
    deps: [],
  })
  const rows: AdminAccount[] = listData?.admins ?? []
  const [busyId, setBusyId] = useState<number | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [createForm, setCreateForm] = useState({ username: '', password: '', name: '', role: 'operator' })
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const [passwordTarget, setPasswordTarget] = useState<AdminAccount | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [savingPassword, setSavingPassword] = useState(false)

  const [removeTarget, setRemoveTarget] = useState<AdminAccount | null>(null)
  const [removing, setRemoving] = useState(false)

  const doCreate = async () => {
    if (!createForm.username.trim() || !createForm.password) {
      setCreateError('账号与密码为必填项')
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      await api.admins.create({
        username: createForm.username.trim(),
        password: createForm.password,
        name: createForm.name.trim() || undefined,
        role: createForm.role,
      })
      toast.success('管理员已创建')
      setCreateOpen(false)
      setCreateForm({ username: '', password: '', name: '', role: 'operator' })
      load()
    } catch (e) {
      setCreateError(errorMessageOf(e, '创建失败'))
    } finally {
      setCreating(false)
    }
  }

  const doResetPassword = async () => {
    if (!passwordTarget) return
    if (newPassword.length < 8) {
      setPasswordError('新密码至少 8 位')
      return
    }
    setSavingPassword(true)
    setPasswordError(null)
    try {
      await api.admins.resetPassword(passwordTarget.id, newPassword)
      toast.success(`已重置 ${passwordTarget.username} 的密码`)
      setPasswordTarget(null)
      setNewPassword('')
    } catch (e) {
      setPasswordError(errorMessageOf(e, '重置失败'))
    } finally {
      setSavingPassword(false)
    }
  }

  const toggleStatus = async (row: AdminAccount) => {
    const next = row.status === 'disabled' ? 'active' : 'disabled'
    setBusyId(row.id)
    try {
      await api.admins.setStatus(row.id, next)
      toast.success(next === 'disabled' ? `已禁用 ${row.username}` : `已启用 ${row.username}`)
      load()
    } catch (e) {
      toast.error(errorMessageOf(e, '操作失败'))
    } finally {
      setBusyId(null)
    }
  }

  const doRemove = async () => {
    if (!removeTarget) return
    setRemoving(true)
    try {
      await api.admins.remove(removeTarget.id)
      toast.success(`已删除管理员 ${removeTarget.username}`)
      setRemoveTarget(null)
      load()
    } catch (e) {
      toast.error(errorMessageOf(e, '删除失败'))
    } finally {
      setRemoving(false)
    }
  }

  const superCount = rows.filter((r) => r.role === 'super' && r.status === 'active').length

  return (
    <div>
      <PageHeader
        title="管理员"
        description="后台账号。超级管理员可管理其它账号；运营账号只能查看数据与做日常处置。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              刷新
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              新建管理员
            </Button>
          </>
        }
      />

      <Card className="mb-3 border-amber-200 bg-amber-50">
        <CardContent className="p-3 text-xs text-amber-800">
          当前共有 <strong>{superCount}</strong> 个启用中的超级管理员。
          系统会强制保留至少一个，且不允许禁用或删除自己的账号。
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <DataState loading={loading && rows.length === 0} error={error} empty={rows.length === 0} onRetry={load}>
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>账号</TableHead>
                  <TableHead>角色</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>最近登录</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const isMe = row.id === me?.id
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">{row.username}</span>
                          {isMe ? <ToneBadge tone="blue">当前登录</ToneBadge> : null}
                        </div>
                        <div className="text-xs text-muted-foreground">{row.name}</div>
                      </TableCell>
                      <TableCell>
                        <ToneBadge tone={row.role === 'super' ? 'purple' : 'gray'}>
                          {row.role === 'super' ? '超级管理员' : '运营'}
                        </ToneBadge>
                      </TableCell>
                      <TableCell>
                        <ToneBadge tone={row.status === 'disabled' ? 'red' : 'green'}>
                          {row.status === 'disabled' ? '已禁用' : '正常'}
                        </ToneBadge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDateTime(row.lastLoginAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDateTime(row.createdAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isMe}
                            onClick={() => {
                              setPasswordTarget(row)
                              setNewPassword('')
                              setPasswordError(null)
                            }}
                            title={isMe ? '请在「账号设置」中修改自己的密码' : '重置密码'}
                          >
                            <KeyRound className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isMe || busyId === row.id}
                            onClick={() => toggleStatus(row)}
                            title={isMe ? '不能修改自己的状态' : row.status === 'disabled' ? '启用' : '禁用'}
                          >
                            {busyId === row.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : row.status === 'disabled' ? (
                              <ShieldCheck className="h-3.5 w-3.5" />
                            ) : (
                              <ShieldOff className="h-3.5 w-3.5" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            disabled={isMe}
                            onClick={() => setRemoveTarget(row)}
                            title={isMe ? '不能删除自己' : '删除'}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </DataState>
      </Card>

      {/* 新建 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>新建管理员</DialogTitle>
            <DialogDescription>所有后台操作都会记入操作日志，请按最小权限原则分配角色。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>登录账号</Label>
              <Input
                value={createForm.username}
                onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
                placeholder="至少 3 位，字母/数字/下划线"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label>初始密码</Label>
              <Input
                type="password"
                value={createForm.password}
                onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                placeholder="至少 8 位"
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-1.5">
              <Label>姓名（可选）</Label>
              <Input
                value={createForm.name}
                onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                placeholder="用于日志中标识操作人"
              />
            </div>
            <div className="space-y-1.5">
              <Label>角色</Label>
              <Select
                value={createForm.role}
                onChange={(e) => setCreateForm({ ...createForm, role: e.target.value })}
              >
                <option value="operator">运营 —— 可查看数据、处置内容，不能管理管理员账号</option>
                <option value="super">超级管理员 —— 拥有全部权限</option>
              </Select>
            </div>
            {createError ? <p className="text-sm text-destructive">{createError}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              取消
            </Button>
            <Button onClick={doCreate} disabled={creating}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {creating ? '创建中…' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重置密码 */}
      <Dialog
        open={Boolean(passwordTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setPasswordTarget(null)
            setNewPassword('')
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>重置密码</DialogTitle>
            <DialogDescription>
              为「{passwordTarget?.username}」设置新密码。重置后请通过安全渠道告知本人。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>新密码</Label>
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="至少 8 位"
              autoComplete="new-password"
            />
            {passwordError ? <p className="text-sm text-destructive">{passwordError}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPasswordTarget(null)} disabled={savingPassword}>
              取消
            </Button>
            <Button onClick={doResetPassword} disabled={savingPassword}>
              {savingPassword ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {savingPassword ? '保存中…' : '确认重置'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onOpenChange={(open) => (!open ? setRemoveTarget(null) : null)}
        title="删除管理员"
        description={
          <>
            将删除管理员「{removeTarget?.username}（{removeTarget?.name}）」。该账号将立即失去后台访问权限，
            其历史操作日志会保留以便追溯。
          </>
        }
        confirmText="删除"
        loading={removing}
        requireText={removeTarget?.username}
        onConfirm={doRemove}
      />
    </div>
  )
}
