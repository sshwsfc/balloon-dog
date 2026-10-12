import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, Languages } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { LANGUAGES, getLanguage, isSupportedLanguage, setLanguage, type LanguageCode } from '@/i18n'

/**
 * 语言切换入口。
 *
 * 语言名一律用**各语言自己的写法**（简体中文 / English），不跟着界面语言翻译 ——
 * 用户不小心切到看不懂的语言时，总得有办法切回来。
 */
export function LanguageSetting() {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const current: LanguageCode = isSupportedLanguage(i18n.language) ? i18n.language : getLanguage()
  const currentLabel = LANGUAGES.find((l) => l.code === current)?.label ?? current

  return (
    <>
      <Card>
        <CardContent className="p-0">
          <button
            type="button"
            className="w-full flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left"
            onClick={() => setOpen(true)}
          >
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-indigo-50 rounded-lg flex items-center justify-center">
                <Languages className="w-5 h-5 text-indigo-500" />
              </div>
              <div>
                <h4 className="font-medium text-gray-900 text-sm">{t('语言')}</h4>
                <p className="text-xs text-gray-400 mt-0.5">{currentLabel}</p>
              </div>
            </div>
            <ChevronRight className="w-5 h-5 text-gray-300" />
          </button>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[320px]">
          <DialogHeader>
            <DialogTitle>{t('语言')}</DialogTitle>
          </DialogHeader>
          <div className="-mx-1">
            {LANGUAGES.map((language) => (
              <button
                key={language.code}
                type="button"
                className="w-full flex items-center justify-between px-3 py-3 rounded-lg hover:bg-gray-50 active:bg-gray-100 transition-colors text-left"
                onClick={() => {
                  setLanguage(language.code)
                  setOpen(false)
                }}
              >
                <span className="text-sm text-gray-900">{language.label}</span>
                {language.code === current && <Check className="w-4 h-4 text-[#07c160]" />}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
