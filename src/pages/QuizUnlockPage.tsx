import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { ArrowLeft, Settings, Clock, CheckCircle, XCircle, BookOpen, Image as ImageIcon, Play } from 'lucide-react'
import { api } from '@/services/api'
import type { QuizConfig, QuizStatistics, QuizRecord } from '@/types'

export function QuizUnlockPage() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [config, setConfig] = useState<QuizConfig | null>(null)
  const [statistics, setStatistics] = useState<QuizStatistics | null>(null)
  const [records, setRecords] = useState<QuizRecord[]>([])

  const [quizType, setQuizType] = useState('')
  const [questionBank, setQuestionBank] = useState('')
  const [correctRewardMinutes, setCorrectRewardMinutes] = useState('3')
  const [randomMode, setRandomMode] = useState(false)

  const questionBanks = [
    { id: 'grade1', name: '一年级教材' },
    { id: 'grade2', name: '二年级教材' },
    { id: 'grade3', name: '三年级教材' },
    { id: 'grade4', name: '四年级教材' },
    { id: 'grade5', name: '五年级教材' },
    { id: 'grade6', name: '六年级教材' },
  ]

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      const [configData, statsData, recordsData] = await Promise.all([
        api.getQuizConfig(),
        api.getQuizStatistics(),
        api.getQuizRecords({ limit: 20 })
      ])
      setConfig(configData)
      setStatistics(statsData)
      setRecords(recordsData.records || [])
      setQuizType(configData.quizType || '')
      setQuestionBank(configData.questionBank || '')
      setCorrectRewardMinutes(configData.correctRewardMinutes?.toString() || '3')
      setRandomMode(configData.randomMode || false)
    } catch (error) {
      toast.error('加载数据失败，请刷新页面重试')
      console.error('Failed to load quiz data:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleToggleEnabled = async () => {
    if (!config) return
    try {
      const newConfig = {
        enabled: !config.enabled,
        quizType,
        questionBank,
        correctRewardMinutes: parseInt(correctRewardMinutes),
        randomMode
      }
      await api.updateQuizConfig(newConfig)
      await loadData()
      toast.success(!config.enabled ? '答题解锁已开启' : '答题解锁已关闭')
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '操作失败，请稍后重试'
      toast.error(message)
      console.error('Failed to toggle quiz unlock:', error)
    }
  }

  const handleSaveConfig = async () => {
    if (!config) return
    try {
      const newConfig = {
        enabled: config.enabled,
        quizType,
        questionBank,
        correctRewardMinutes: parseInt(correctRewardMinutes),
        randomMode
      }
      await api.updateQuizConfig(newConfig)
      await loadData()
      toast.success('设置已保存')
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '操作失败，请稍后重试'
      toast.error(message)
      console.error('Failed to save quiz config:', error)
    }
  }

  const getQuizTypeName = (type: string) => {
    const typeMap: Record<string, string> = {
      english: '英文单词意思选择',
      poetry: '古诗填空',
      random: '随机出题'
    }
    return typeMap[type] || type
  }

  if (loading) {
    return (
      <div className="page-shell page-shell--immersive page-shell--center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#07c160]"></div>
          <p className="mt-2 text-gray-500 text-sm">加载中...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page-shell page-shell--immersive">
      <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-medium text-gray-900 flex-1">答题解锁</h1>
      </div>

      <div className="px-3 py-3">
        <Card className="overflow-hidden">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3 flex-1">
                <div className="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center flex-shrink-0">
                  <Settings className="w-5 h-5 text-green-500" />
                </div>
                <div className="flex-1">
                  <div className="font-medium text-gray-900">开启答题解锁</div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {config?.enabled ? '开启后孩子设备会弹出答题框' : '关闭后答题解锁功能不生效'}
                  </div>
                </div>
              </div>
              <div
                className="w-12 h-6 rounded-full relative cursor-pointer"
                onClick={handleToggleEnabled}
              >
                <div className={`absolute w-5 h-5 rounded-full top-0.5 transition-all ${config?.enabled ? 'right-0.5 bg-[#07c160]' : 'left-0.5 bg-gray-300'}`} />
                <div className={`w-full h-full rounded-full ${config?.enabled ? 'bg-green-100' : 'bg-gray-200'}`} />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {config?.enabled && (
        <>
          <div className="px-3 mt-3">
            <div className="mb-2 px-1">
              <span className="text-sm font-medium text-gray-500">答题设置</span>
            </div>
            <Card className="overflow-hidden">
              <CardContent className="p-4 space-y-4">
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-2">答题类型</p>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { id: 'english', name: '英文单词', icon: BookOpen },
                      { id: 'poetry', name: '古诗填空', icon: BookOpen },
                      { id: 'random', name: '随机出题', icon: Play }
                    ].map((type) => (
                      <Button
                        key={type.id}
                        variant="outline"
                        onClick={() => setQuizType(type.id)}
                        className={quizType === type.id ? 'border-[#07c160] text-[#07c160]' : ''}
                      >
                        <type.icon className="w-4 h-4 mr-1" />
                        {type.name}
                      </Button>
                    ))}
                  </div>
                </div>

                {quizType !== 'random' && (
                  <div>
                    <p className="text-sm font-medium text-gray-700 mb-2">选择题库</p>
                    <div className="grid grid-cols-3 gap-2">
                      {questionBanks.map((bank) => (
                        <Button
                          key={bank.id}
                          variant="outline"
                          onClick={() => setQuestionBank(bank.id)}
                          className={questionBank === bank.id ? 'border-[#07c160] text-[#07c160]' : ''}
                        >
                          {bank.name}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center space-x-2">
                    <ImageIcon className="w-4 h-4 text-gray-600" />
                    <span className="text-sm text-gray-700">根据屏幕画面随机出题</span>
                  </div>
                  <div
                    className="w-10 h-6 rounded-full relative cursor-pointer"
                    onClick={() => setRandomMode(!randomMode)}
                  >
                    <div className={`absolute w-5 h-5 rounded-full top-0.5 transition-all ${randomMode ? 'right-0.5 bg-[#07c160]' : 'left-0.5 bg-gray-300'}`} />
                    <div className={`w-full h-full rounded-full ${randomMode ? 'bg-green-100' : 'bg-gray-200'}`} />
                  </div>
                </div>

                <div>
                  <p className="text-sm font-medium text-gray-700 mb-2">答对奖励时长（分钟）</p>
                  <div className="flex items-center space-x-2">
                    <div className="grid grid-cols-4 gap-2 flex-1">
                      {[1, 3, 5, 10].map((min) => (
                        <Button
                          key={min}
                          variant="outline"
                          onClick={() => setCorrectRewardMinutes(min.toString())}
                          className={correctRewardMinutes === min.toString() ? 'border-[#07c160] text-[#07c160]' : ''}
                        >
                          {min}分钟
                        </Button>
                      ))}
                    </div>
                    <input
                      type="number"
                      value={correctRewardMinutes}
                      onChange={(e) => setCorrectRewardMinutes(e.target.value)}
                      placeholder="自定义"
                      className="w-20 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
                    />
                  </div>
                </div>

                <Button className="w-full bg-[#07c160] hover:bg-[#06a050]" onClick={handleSaveConfig}>
                  保存设置
                </Button>
              </CardContent>
            </Card>
          </div>

          <div className="px-3 mt-3">
            <div className="mb-2 px-1">
              <span className="text-sm font-medium text-gray-500">答题统计</span>
            </div>
            <Card className="overflow-hidden">
              <CardContent className="p-4">
                {statistics && (
                  <>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <div className="bg-blue-50 p-3 rounded-lg">
                        <div className="text-2xl font-bold text-blue-600">{statistics.totalQuestions}</div>
                        <div className="text-xs text-gray-600 mt-1">总答题数</div>
                      </div>
                      <div className="bg-green-50 p-3 rounded-lg">
                        <div className="text-2xl font-bold text-green-600">{statistics.correctCount}</div>
                        <div className="text-xs text-gray-600 mt-1">正确数量</div>
                      </div>
                      <div className="bg-red-50 p-3 rounded-lg">
                        <div className="text-2xl font-bold text-red-600">{statistics.incorrectCount}</div>
                        <div className="text-xs text-gray-600 mt-1">错误数量</div>
                      </div>
                      <div className="bg-purple-50 p-3 rounded-lg">
                        <div className="text-2xl font-bold text-purple-600">{(statistics.accuracyRate * 100).toFixed(1)}%</div>
                        <div className="text-xs text-gray-600 mt-1">正确率</div>
                      </div>
                    </div>
                    <div className="mt-3 bg-yellow-50 p-3 rounded-lg">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-700">累计获得奖励时长</span>
                        <span className="text-lg font-bold text-yellow-600">{statistics.totalRewardMinutes} 分钟</span>
                      </div>
                    </div>
                    <div className="mt-3 space-y-2">
                      <p className="text-xs text-gray-500 mb-2">各类型答题情况：</p>
                      {Object.entries(statistics.byType).map(([type, data]: [string, { total: number; correct: number; accuracy: number }]) => (
                        <div key={type} className="flex items-center justify-between text-sm p-2 bg-gray-50 rounded">
                          <span className="text-gray-700">{getQuizTypeName(type)}</span>
                          <div className="flex items-center space-x-3">
                            <span className="text-gray-500">{data.total}题</span>
                            <span className="text-green-600">{(data.accuracy * 100).toFixed(1)}%</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="px-3 mt-3">
            <div className="mb-2 px-1">
              <span className="text-sm font-medium text-gray-500">最近答题记录</span>
            </div>
            <Card className="overflow-hidden">
              <CardContent className="p-0">
                {records.length > 0 ? (
                  <div className="divide-y divide-gray-100">
                    {records.map((record) => (
                      <div key={record.id} className="p-3 hover:bg-gray-50">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center space-x-2">
                              <Badge className={record.isCorrect ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}>
                                {record.isCorrect ? '正确' : '错误'}
                              </Badge>
                              <span className="text-xs text-gray-500">{getQuizTypeName(record.type)}</span>
                            </div>
                            <p className="text-sm text-gray-900 mt-1 line-clamp-2">{record.question}</p>
                            <p className="text-xs text-gray-500 mt-1">
                              {new Date(record.timestamp).toLocaleString('zh-CN')}
                              {record.isCorrect && record.rewardMinutes && (
                                <span className="text-green-600 ml-2">+{record.rewardMinutes}分钟</span>
                              )}
                            </p>
                          </div>
                          <div className={`flex-shrink-0 ${record.isCorrect ? 'text-green-500' : 'text-red-500'}`}>
                            {record.isCorrect ? <CheckCircle className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="p-8 text-center">
                    <Clock className="w-12 h-12 text-gray-300 mx-auto mb-2" />
                    <p className="text-gray-500">暂无答题记录</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
