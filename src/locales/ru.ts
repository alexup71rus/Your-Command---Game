import type { LocaleDictionary } from '../config/localization'

const ru: LocaleDictionary = {
  localeName: 'Русский',
  hud: {
    state: 'Состояние владения',
    resources: 'Ресурсы',
    people: 'Люди',
    army: 'Нанятые войска',
    turn: 'Текущий ход',
    ordersAvailable: 'Доступно приказов',
  },
  resources: ['Дерево', 'Камень', 'Железо', 'Зерно', 'Мясо', 'Золото'],
  troops: ['Ополчение', 'Копейщики', 'Лучники', 'Мечники', 'Конница'],
  tabs: [
    { id: 'buildings', label: 'Здания' },
    { id: 'barracks', label: 'Казарма' },
    { id: 'castle', label: 'Замок' },
  ],
  interface: {
    controlPanel: 'Панель управления',
    controlSections: 'Разделы управления',
    mapAria: 'Карта игрового мира. Перетаскивайте мышью и используйте колесо для масштаба.',
    mapHint: 'Перетащите карту · колесо — масштаб · ПКМ — меню',
    settingsHint: 'Настройки',
  },
  sound: {
    title: 'Звук',
    description: 'Звуки интерфейса и действий на карте',
    enable: 'Включить звук',
    disable: 'Выключить звук',
    enabled: 'Включён',
    disabled: 'Выключен',
  },
  contextMenu: {
    title: 'Действия с клеткой',
    cell: 'Клетка',
    splitSquad: 'Разделить отряд',
    mergeSquads: 'Объединить отряды',
    removeObject: 'Удалить объект',
  },
  settings: {
    title: 'Настройки',
    close: 'Закрыть настройки',
    language: 'Язык',
    languageDescription: 'Язык интерфейса загружается отдельно',
    mapGenerator: 'Генератор карты',
    mapGeneratorDescription: 'Рельеф, непроходимые высоты и растительность',
    openGenerator: 'Открыть генератор',
  },
  generator: {
    title: 'Генератор мира', close: 'Закрыть генератор', devLabel: 'DEV · НАСТРОЙКИ',
    relief: 'Рельеф', source: 'Источник', automatic: 'Полностью автоматически', hybrid: 'Авто + ручные узлы', manual: 'Преимущественно вручную',
    hills: 'Холмы и высоты', peaks: 'Непроходимые пики', formScale: 'Масштаб форм', reliefDistribution: 'К краям ← рельеф → к центру',
    vegetation: 'Растительность', coverage: 'Покрытие', vegetationDistribution: 'К краям ← зелень → к центру', heightPreference: 'Предпочтение высоты',
    lowlands: 'Низины', balanced: 'Средние высоты', highlands: 'Возвышенности', reliefInfluence: 'Влияние рельефа',
    brushAria: 'Кисть рельефа', erase: 'Стереть', hill: 'Холм', mountain: 'Гора', clearNodes: 'Очистить узлы', previewAria: 'Превью карты и редактор крупных форм рельефа',
    plain: 'Равнина', elevation: 'Высота', forest: 'Лес', peak: 'Пик', seed: 'Семя',
    note: 'Рисуйте крупные узлы на превью. Они плавно распространяются на реальные клетки; лес избегает непроходимых пиков и крутых склонов.',
    vegetationOnly: 'Пересобрать только зелень', newVariant: 'Новый вариант', apply: 'Применить карту',
  },
}

export default ru
