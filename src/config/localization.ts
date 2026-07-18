const ru = {
  hud: {
    resources: 'Ресурсы',
    population: 'Население',
    people: 'Люди',
    army: 'Нанятые войска',
    turn: 'Текущий ход',
    orders: 'Приказы на ход',
    ordersAvailable: 'Доступно приказов',
    outOf: 'из',
  },
  resources: ['Дерево', 'Камень', 'Железо', 'Зерно', 'Мясо', 'Золото'],
  troops: ['Ополчение', 'Копейщики', 'Лучники', 'Мечники', 'Конница'],
  tabs: ['Здания', 'Казарма', 'Замок'],
  mapHint: 'Перемещение · колесо — масштаб · ПКМ — меню',
  sound: {
    enable: 'Включить звук',
    disable: 'Выключить звук',
  },
  contextMenu: {
    title: 'Действия с клеткой',
    cell: 'Клетка',
    splitSquad: 'Разделить отряд',
    mergeSquads: 'Объединить отряды',
    removeObject: 'Удалить объект',
  },
} as const

export const translations = { ru } as const
export type Locale = keyof typeof translations
export const defaultLocale: Locale = 'ru'

// Единственная точка доступа к тексту интерфейса. Переключение языка добавим позже.
export const text = translations[defaultLocale]
