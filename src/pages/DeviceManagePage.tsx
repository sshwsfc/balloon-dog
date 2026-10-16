import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import { ArrowLeft, Battery, Check, Crown, Eye, HelpCircle, Plus, ShieldCheck, Smartphone, Trash2, Users, UserPlus, Wifi } from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import { FeatureTip } from '@/components/FeatureTip'
import { AgentInstallCard } from '@/components/onboarding/AgentInstallCard'
import { formatRelative } from '@/lib/format'
import { invalidateAppIcons } from '@/hooks/useAppIcons'
import { useMembership } from '@/hooks/useMembership'
import type { Device, DeviceMember, DeviceRole } from '@/types'
import { useTranslation } from 'react-i18next'

type DevicesResponse = { devices: Device[] }

export function DeviceManagePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { isMember } = useMembership()
  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [helpDialogOpen, setHelpDialogOpen] = useState(false)
  const [deviceCode, setDeviceCode] = useState('')
  const [newDeviceName, setNewDeviceName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const [removeTarget, setRemoveTarget] = useState<Device | null>(null)
  const [removing, setRemoving] = useState(false)

  /**
   * 家庭成员（规划 §5.1）。
   *
   * 一个弹窗装完「看名单 + 邀请 + 改角色 + 移出」：这几件事互相依赖（改完角色要
   * 立刻看到名单更新，邀请完要看到人数涨了），拆成多个页面反而要来回跳。
   * 非主人打开时整块管理区不渲染 —— 服务端同样会 403，前端不靠这个挡住人。
   */
  const [memberTarget, setMemberTarget] = useState<Device | null>(null)
  const [members, setMembers] = useState<DeviceMember[]>([])
  const [memberLimit, setMemberLimit] = useState(5)
  const [memberLoading, setMemberLoading] = useState(false)
  const [memberBusy, setMemberBusy] = useState(false)
  const [invitePhone, setInvitePhone] = useState('')
  const [inviteNickname, setInviteNickname] = useState('')
  const [inviteRole, setInviteRole] = useState<DeviceRole>('viewer')

  const loadDevices = useCallback(async () => {
    try {
      const res: DevicesResponse = await api.getDevices()
      setDevices(res.devices ?? [])
      setError(null)
    } catch (err) {
      setError(toUserMessage(err, t('加载设备列表失败')))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadDevices()
  }, [loadDevices])

  /**
   * 绑定设备。
   * 与 mock 版的根本差别：设备必须已经在孩子手机上装好 Agent 并完成注册
   * （屏幕上会显示 8 位设备码），家长输入的是**真实存在的**设备码。
   * 因此这里不再让家长手填型号/系统 —— 那些信息由设备自己上报。
   */
  /** 普通账号只能绑 1 台设备，第二台起要会员（服务端同样会拦） */
  const bindLocked = !isMember && devices.length >= 1

  const handleBindDevice = async () => {
    const code = deviceCode.trim().toUpperCase()
    if (!/^[A-Z0-9]{6,12}$/.test(code)) {
      toast.error(t('请输入孩子端显示的 6-12 位绑定码'))
      return
    }
    setSubmitting(true)
    try {
      const res = await api.bindDevice({
        deviceCode: code,
        name: newDeviceName.trim() || undefined,
      })
      toast.success(res.alreadyBound ? t('这台设备已在你账号下') : t('设备绑定成功'))
      // 新绑定的设备会成为当前设备，图标缓存同样要作废
      invalidateAppIcons()
      setAddDialogOpen(false)
      setDeviceCode('')
      setNewDeviceName('')
      await loadDevices()
    } catch (err) {
      toast.error(toUserMessage(err, t('绑定设备失败')))
    } finally {
      setSubmitting(false)
    }
  }

  const handleSelect = async (device: Device) => {
    try {
      await api.selectDevice(device.id)
      // 图标表是按「当前设备」拉回来缓存的：换了设备必须作废，
      // 否则新设备的应用列表会沿用上一台设备的图标。
      invalidateAppIcons()
      toast.success(t('已切换到「{{v0}}」', { v0: device.name }))
      navigate('/')
    } catch (err) {
      toast.error(toUserMessage(err, t('切换设备失败')))
    }
  }

  /**
   * 点设备卡上的健康点：先把这台设备切成「当前设备」，再进健康页。
   *
   * 健康接口是**按当前设备**取的（`GET /api/device/health`），所以不能直接带上
   * `?deviceId=` 跳过去 —— 那会让家长看到另一台设备的开关状态，
   * 而他以为自己在看刚点的那台。先切换、再跳转，看到的一定是同一台。
   */
  const handleOpenHealth = async (device: Device) => {
    try {
      await api.selectDevice(device.id)
      invalidateAppIcons()
      navigate('/device-health')
    } catch (err: unknown) {
      toast.error(toUserMessage(err, t('切换设备失败')))
    }
  }

  const loadMembers = useCallback(
    async (deviceId: string) => {
      setMemberLoading(true)
      try {
        const res = await api.getDeviceMembers(deviceId)
        setMembers(res.members ?? [])
        setMemberLimit(res.limit ?? 5)
      } catch (err) {
        toast.error(toUserMessage(err, t('加载家庭成员失败')))
      } finally {
        setMemberLoading(false)
      }
    },
    [t],
  )

  const handleOpenMembers = (device: Device) => {
    setMemberTarget(device)
    setMembers([])
    setInvitePhone('')
    setInviteNickname('')
    setInviteRole('viewer')
    void loadMembers(device.id)
  }

  const handleInviteMember = async () => {
    if (!memberTarget) return
    const phone = invitePhone.trim()
    if (!/^1\d{10}$/.test(phone)) {
      toast.error(t('请输入成员注册时用的 11 位手机号'))
      return
    }
    setMemberBusy(true)
    try {
      await api.inviteDeviceMember(memberTarget.id, {
        phone,
        role: inviteRole,
        nickname: inviteNickname.trim() || undefined,
      })
      toast.success(t('已加入家庭成员，他打开应用就能看到这台设备'))
      setInvitePhone('')
      setInviteNickname('')
      await loadMembers(memberTarget.id)
      // 列表页没有成员信息，但主人自己那行的角色不会变，这里只是保持一致的刷新时机
      await loadDevices()
    } catch (err) {
      toast.error(toUserMessage(err, t('邀请失败，请稍后重试')))
    } finally {
      setMemberBusy(false)
    }
  }

  const handleChangeMemberRole = async (member: DeviceMember, role: DeviceRole) => {
    if (!memberTarget) return
    setMemberBusy(true)
    try {
      await api.updateDeviceMember(memberTarget.id, member.id, { role })
      toast.success(role === 'admin' ? t('已设为管理员') : t('已设为只读'))
      await loadMembers(memberTarget.id)
    } catch (err) {
      toast.error(toUserMessage(err, t('修改角色失败')))
    } finally {
      setMemberBusy(false)
    }
  }

  const handleRemoveMember = async (member: DeviceMember) => {
    if (!memberTarget) return
    setMemberBusy(true)
    try {
      await api.removeDeviceMember(memberTarget.id, member.id)
      toast.success(t('已移出家庭成员'))
      await loadMembers(memberTarget.id)
    } catch (err) {
      toast.error(toUserMessage(err, t('移除成员失败')))
    } finally {
      setMemberBusy(false)
    }
  }

  const handleRemove = async () => {
    if (!removeTarget) return
    setRemoving(true)
    try {
      await api.deleteDevice(removeTarget.id)
      toast.success(t('已解绑「{{v0}}」', { v0: removeTarget.name }))
      setRemoveTarget(null)
      // 解绑的可能正是当前设备，后端会切到另一台，图标缓存跟着作废
      invalidateAppIcons()
      await loadDevices()
    } catch (err) {
      toast.error(toUserMessage(err, t('解绑失败')))
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="page-shell">
      <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-medium text-gray-900 flex-1">{t('设备管理')}</h1>
        <Button variant="ghost" size="icon" onClick={() => setHelpDialogOpen(true)} aria-label={t('如何获取绑定码')}>
          <HelpCircle className="w-5 h-5 text-gray-400" />
        </Button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="text-center">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#07c160]" />
            <p className="mt-2 text-gray-500 text-sm">{t('加载中...')}</p>
          </div>
        </div>
      )}

      {!loading && error && (
        <div className="px-4 py-16 text-center">
          <p className="text-gray-700">{error}</p>
          <Button
            className="mt-4 bg-[#07c160] hover:bg-[#06a050]"
            onClick={() => {
              setLoading(true)
              void loadDevices()
            }}
          >
            {t('重试')}
          </Button>
        </div>
      )}

      {!loading && !error && (
        <>
          <div className="px-3 py-3 space-y-3">
            {devices.length === 0 ? (
              <Card>
                <CardContent className="p-8 text-center">
                  <Smartphone className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                  <p className="text-gray-700 font-medium">{t('还没有绑定任何设备')}</p>
                  <p className="text-sm text-gray-500 mt-2">
                    {t('先在孩子手机上装好气球狗客户端，再输入它首页的绑定码。')}
                  </p>
                  <Button
                    className="mt-4 bg-[#07c160] hover:bg-[#06a050]"
                    onClick={() => setAddDialogOpen(true)}
                  >
                    <Plus className="w-4 h-4 mr-1" />
                    {t('绑定设备')}
                  </Button>
                </CardContent>
              </Card>
            ) : (
              devices.map((device) => (
                <Card key={device.id} className="overflow-hidden">
                  <CardContent className="p-4">
                    <div className="flex items-start space-x-3">
                      <div className="w-12 h-12 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
                        <Smartphone className="w-6 h-6 text-blue-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center space-x-2">
                          <h3 className="font-medium text-gray-900 truncate">{device.name}</h3>
                          <Badge
                            className={
                              device.status === 'online'
                                ? 'bg-[#07c160] text-white'
                                : 'bg-gray-400 text-white'
                            }
                          >
                            {device.status === 'online' ? t('在线') : t('离线')}
                          </Badge>
                          {device.locked && <Badge className="bg-red-500 text-white">{t('已锁定')}</Badge>}
                          {/*
                            角色角标（规划 §5.1）：被邀请进来的家长要一眼看出自己
                            在这台设备上是「能改」还是「只能看」——否则他会一直点开关，
                            然后被服务端 403。
                          */}
                          {device.role === 'admin' && (
                            <Badge className="bg-blue-100 text-blue-700">{t('管理员')}</Badge>
                          )}
                          {device.role === 'viewer' && (
                            <Badge className="bg-gray-100 text-gray-600">{t('只读')}</Badge>
                          )}
                          {/*
                            健康点（规划 §1.2）：一眼看出这台设备的管控还成不成立。
                            没上报过快照时**不画点**，只写「未检测」—— 画个灰点也会被
                            读成「大概没事」，而这里的事实是「我们不知道」。
                          */}
                          {device.healthLevel ? (
                            <button
                              type="button"
                              className="flex items-center space-x-1"
                              onClick={() => void handleOpenHealth(device)}
                            >
                              <span
                                className={`w-2 h-2 rounded-full ${
                                  device.healthLevel === 'ok'
                                    ? 'bg-[#07c160]'
                                    : device.healthLevel === 'warn'
                                      ? 'bg-amber-500'
                                      : 'bg-red-500'
                                }`}
                              />
                              <span
                                className={`text-[11px] ${
                                  device.healthLevel === 'ok'
                                    ? 'text-[#07c160]'
                                    : device.healthLevel === 'warn'
                                      ? 'text-amber-600'
                                      : 'text-red-500'
                                }`}
                              >
                                {device.openGaps
                                  ? t('{{v0}} 项待处理', { v0: device.openGaps })
                                  : t('管控正常')}
                              </span>
                            </button>
                          ) : (
                            <span className="text-[11px] text-gray-300">{t('未检测')}</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 mt-1 truncate">
                          {device.model} · {device.os}
                        </p>
                        <div className="flex items-center space-x-4 mt-2 text-xs text-gray-500">
                          <span className="flex items-center">
                            <Battery className="w-3.5 h-3.5 mr-1" />
                            {device.battery}%
                          </span>
                          <span className="flex items-center">
                            <Wifi className="w-3.5 h-3.5 mr-1" />
                            {device.network || t('未知')}
                          </span>
                          <span>{device.lastActiveAt ? formatRelative(device.lastActiveAt) : t('未知')}</span>
                        </div>
                        <p className="text-[11px] text-gray-300 mt-2 font-mono">
                          {t('绑定码')} {device.deviceCode}
                          {device.agentVersion ? t(' · 客户端 v{{v0}}', { v0: device.agentVersion }) : ''}
                        </p>
                      </div>
                    </div>

                    <div className="flex gap-2 mt-3 flex-wrap">
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1"
                        onClick={() => void handleSelect(device)}
                      >
                        <Check className="w-4 h-4 mr-1" />
                        {t('设为当前设备')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1"
                        onClick={() => handleOpenMembers(device)}
                      >
                        {device.canManageMembers ? (
                          <Users className="w-4 h-4 mr-1" />
                        ) : (
                          <Eye className="w-4 h-4 mr-1" />
                        )}
                        {t('家庭成员')}
                      </Button>
                      {/*
                        解绑只有主人能做：服务端对所有人的 removeDevice 都校验主人身份，
                        这里再画一个按钮只会让管理员点出一个 403。
                      */}
                      {device.role !== 'admin' && device.role !== 'viewer' && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-red-500 border-red-200 hover:bg-red-50"
                          onClick={() => setRemoveTarget(device)}
                        >
                          <Trash2 className="w-4 h-4 mr-1" />
                          {t('解绑')}
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))
            )}

            {devices.length > 0 &&
              (bindLocked ? (
                /*
                  普通账号只能绑 1 台。这里不把按钮做成 disabled ——
                  禁用的按钮点下去毫无反馈，家长只会以为坏了；
                  换成明说原因 + 直达会员中心的入口。
                  （真正的把关在服务端，这里只是不让家长白填一遍表单再被 403 弹回来。）
                */
                <button
                  type="button"
                  onClick={() => navigate('/membership')}
                  className="w-full rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-left active:bg-amber-100"
                >
                  <span className="flex items-center text-sm font-medium text-amber-800">
                    <Crown className="mr-1.5 h-4 w-4" />
                    {t('绑定多台手机是会员功能')}
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-amber-700">
                    {t('普通账号可以绑定 1 台设备，开通会员后可以绑定多台。')}
                  </span>
                </button>
              ) : (
                <Button
                  variant="outline"
                  className="w-full bg-white"
                  onClick={() => setAddDialogOpen(true)}
                >
                  <Plus className="w-4 h-4 mr-1" />
                  {t('绑定新设备')}
                </Button>
              ))}
          </div>

          <div className="px-4 mt-4 text-xs text-gray-400 leading-relaxed">
            <p className="font-medium text-gray-500 mb-1">{t('关于设备绑定')}</p>
            <p>{t('设备首次启动客户端会生成唯一的设备码与密钥。输入设备码完成认领后，就能下发锁屏、拍照等指令。解绑不影响孩子手机上客户端的数据，但会立即停止全部远程控制。')}</p>
          </div>
        </>
      )}

      {/* 绑定设备 */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('绑定孩子设备')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* 绑定码在孩子端首页上，「还没装孩子端」的家长点开这个对话框时手上
                是空的 —— 所以下载方式与二维码放在第一步，而不是让他先关掉对话框
                去别处找入口。 */}
            <section className="rounded-xl border border-gray-100 bg-gray-50 p-3">
              <p className="text-sm font-medium text-gray-800">{t('还没装孩子端？先下载')}</p>
              <p className="mt-1 text-xs leading-relaxed text-gray-500">
                {t('孩子端只装在被管的那台手机上，装好后它首页会显示绑定码，再回来填在下面。')}
              </p>
              <AgentInstallCard compact className="mt-3" />
            </section>
            <div>
              <label className="text-sm text-gray-600 block mb-2">
                {t('设备绑定码')} <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={deviceCode}
                onChange={(e) => setDeviceCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                placeholder={t('例如 A3F9K2M7')}
                maxLength={12}
                autoCapitalize="characters"
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-center text-lg tracking-[0.3em] font-mono focus:outline-none focus:border-[#07c160]"
              />
              <p className="text-xs text-gray-400 mt-2">
                {t('在孩子手机上打开气球狗客户端，首页会显示绑定码。')}
              </p>
            </div>
            <div>
              <label className="text-sm text-gray-600 block mb-2">{t('设备备注名（可选）')}</label>
              <input
                type="text"
                value={newDeviceName}
                onChange={(e) => setNewDeviceName(e.target.value)}
                placeholder={t('例如 小明的手机')}
                maxLength={30}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-[#07c160]"
              />
              <p className="text-xs text-gray-400 mt-2">
                {t('不填则用设备上报的名称；型号和系统也由设备自动上报。')}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialogOpen(false)} disabled={submitting}>
              {t('取消')}
            </Button>
            <Button
              className="bg-[#07c160] hover:bg-[#06a050]"
              onClick={() => void handleBindDevice()}
              disabled={submitting}
            >
              {submitting ? t('绑定中…') : t('确认绑定')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 家庭成员 */}
      <Dialog open={Boolean(memberTarget)} onOpenChange={(open) => !open && setMemberTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('家庭成员')}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-gray-500 -mt-2 leading-relaxed">
            {t('一台设备可以由多位家长一起看：主人能改一切，管理员能改设置和下发指令，只读成员只能看。')}
          </p>
          {memberLoading ? (
            <p className="text-sm text-gray-400 py-6 text-center">{t('加载中...')}</p>
          ) : (
            <div className="space-y-2 max-h-[45vh] overflow-y-auto">
              {members.map((member) => (
                <div
                  key={member.id}
                  className="flex items-center space-x-2 rounded-lg border border-gray-100 p-2.5"
                >
                  <div className="w-8 h-8 rounded-full bg-green-50 flex items-center justify-center flex-shrink-0">
                    {member.isOwner ? (
                      <Crown className="w-4 h-4 text-[#07c160]" />
                    ) : (
                      <Users className="w-4 h-4 text-[#07c160]" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-1.5">
                      <span className="text-sm font-medium text-gray-900 truncate">
                        {member.nickname}
                      </span>
                      <Badge
                        className={
                          member.isOwner
                            ? 'bg-[#07c160] text-white'
                            : member.role === 'admin'
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-gray-100 text-gray-600'
                        }
                      >
                        {t(member.roleLabel)}
                      </Badge>
                    </div>
                    <p className="text-[11px] text-gray-400 mt-0.5">
                      {member.phone || t('未绑定手机号')}
                    </p>
                  </div>
                  {memberTarget?.canManageMembers && !member.isOwner && (
                    <div className="flex items-center space-x-1 flex-shrink-0">
                      <button
                        type="button"
                        disabled={memberBusy}
                        onClick={() =>
                          void handleChangeMemberRole(
                            member,
                            member.role === 'admin' ? 'viewer' : 'admin',
                          )
                        }
                        className="rounded-full bg-gray-50 px-2.5 py-1 text-[11px] text-gray-600 active:bg-gray-100 disabled:opacity-50"
                      >
                        {member.role === 'admin' ? t('降为只读') : t('设为管理员')}
                      </button>
                      <button
                        type="button"
                        disabled={memberBusy}
                        onClick={() => void handleRemoveMember(member)}
                        className="rounded-full bg-red-50 px-2.5 py-1 text-[11px] text-red-600 active:bg-red-100 disabled:opacity-50"
                      >
                        {t('移出')}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {memberTarget?.canManageMembers && (
            <div className="rounded-lg bg-gray-50 p-3 space-y-2">
              <p className="text-xs text-gray-500">
                {t('邀请家人（{{v0}}/{{v1}} 人）', {
                  v0: Math.max(0, members.length - 1),
                  v1: memberLimit,
                })}
              </p>
              <div className="flex gap-2">
                <input
                  value={invitePhone}
                  onChange={(e) => setInvitePhone(e.target.value)}
                  inputMode="numeric"
                  placeholder={t('他的注册手机号')}
                  className="flex-1 min-w-0 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#07c160]"
                />
                <input
                  value={inviteNickname}
                  onChange={(e) => setInviteNickname(e.target.value)}
                  placeholder={t('备注（可选）')}
                  className="w-24 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#07c160]"
                />
              </div>
              <div className="flex items-center gap-2">
                {(['viewer', 'admin'] as DeviceRole[]).map((role) => (
                  <button
                    key={role}
                    type="button"
                    onClick={() => setInviteRole(role)}
                    className={`rounded-full px-3 py-1 text-xs ${
                      inviteRole === role
                        ? 'bg-[#07c160] text-white'
                        : 'bg-white text-gray-600 border border-gray-200'
                    }`}
                  >
                    {role === 'admin' ? t('管理员（能改设置）') : t('只读（只能看）')}
                  </button>
                ))}
              </div>
              <Button
                className="w-full bg-[#07c160] hover:bg-[#06a050]"
                disabled={memberBusy || !invitePhone.trim()}
                onClick={() => void handleInviteMember()}
              >
                <UserPlus className="w-4 h-4 mr-1" />
                {memberBusy ? t('处理中…') : t('邀请加入')}
              </Button>
              <p className="text-[11px] text-gray-400 leading-relaxed">
                {t('对方要先用这个手机号注册过气球狗账号；设备主人不算在人数里，家庭成员最多 5 人。移出后他会立刻失去这台设备的访问权。')}
              </p>
            </div>
          )}
          {!memberTarget?.canManageMembers && (
            <div className="flex items-start space-x-2 rounded-lg bg-amber-50 border border-amber-200 p-2.5">
              <ShieldCheck className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-amber-800 leading-relaxed">
                {t('只有设备主人能邀请或移出家庭成员。')}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setMemberTarget(null)}>
              {t('关闭')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 解绑确认 */}
      <Dialog open={Boolean(removeTarget)} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('解绑设备')}</DialogTitle>
          </DialogHeader>
          <p className="text-gray-600">
            {t('要解绑「')}{removeTarget?.name}{t('」吗？')}
          </p>
          <div className="bg-red-50 text-red-600 text-sm rounded-lg p-3 mt-3">
            {t('解绑后该设备的位置、照片、答题记录会一并删除，无法恢复。')}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)} disabled={removing}>
              {t('取消')}
            </Button>
            <Button
              className="bg-red-500 hover:bg-red-600 text-white"
              onClick={() => void handleRemove()}
              disabled={removing}
            >
              {removing ? t('解绑中…') : t('确认解绑')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 帮助 */}
      <Dialog open={helpDialogOpen} onOpenChange={setHelpDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('如何获取绑定码')}</DialogTitle>
          </DialogHeader>
          <ol className="text-sm text-gray-600 space-y-3 list-decimal list-inside">
            <li>{t('在孩子手机上安装并打开气球狗客户端。')}</li>
            <li>{t('客户端首次启动会自动注册，并在首页显示 8 位绑定码。')}</li>
            <li>{t('在这里输入绑定码，就能把这台设备加入账号。')}</li>
            <li>
              {t('绑定成功后，客户端会立即拉取你设置的管控策略（锁屏、时长、应用限制、网址黑名单）并本地生效。')}
            </li>
          </ol>
          <div className="bg-gray-50 rounded-lg p-3 mt-2">
            <p className="text-xs text-gray-500">{t('绑定码是设备身份的一部分，不要分享 —— 任何人拿到它都能申请绑定这台设备。')}</p>
          </div>
          <DialogFooter>
            <Button onClick={() => setHelpDialogOpen(false)}>{t('知道了')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <FeatureTip id="devices" text={t('绑定码是设备身份的一部分，不要分享给别人 —— 任何人拿到它都能申请绑定这台设备。')} />

    </div>
  )
}
