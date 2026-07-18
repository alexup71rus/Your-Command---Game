import type { LocaleDictionary } from '../config/localization'

const ru: LocaleDictionary = {
  localeName: 'Русский',
  startMenu: {
    eyebrow: 'Пошаговая стратегия', title: 'Ваш приказ',
    description: 'Выберите поле будущей войны и число владений. Замок появится только там, где вы решите основать своё поселение.',
    chooseMap: 'Карты сражений', builtInMaps: 'Встроенные сценарии', myMaps: 'Мои карты', participants: 'Участники', participantDescription: '1 игрок, остальные — NPC',
    humanAndNpc: '1 игрок + NPC', customMap: 'Свой мир', customMapDescription: 'Настройте рельеф, леса и стартовые владения вручную.',
    openGenerator: 'Открыть генератор', seedShort: 'семя', deleteSavedMap: 'Удалить карту', start: 'Перейти к выбору владения', starting: 'Рассчитываем владения…', mapError: 'Не удалось сбалансировать владения. Выберите другую карту или число участников.',
    presets: {
      greenMarches: { name: 'Зелёные марки', description: 'Открытые равнины, мягкие высоты и простор для экономики.' },
      highlandPasses: { name: 'Горные проходы', description: 'Высоты и узкие пути создают естественные линии обороны.' },
      woodedBorder: { name: 'Лесной рубеж', description: 'Густые леса разделяют владения и скрывают направления атаки.' },
    },
  },
  founding: {
    chooseTitle: 'Выберите владение', chooseDescription: 'Области различаются формой и местностью, но близки по стартовой ценности.',
    placeTitle: 'Основать замок', placeDescription: 'Выберите свободную клетку в глубине своего владения. Основание бесплатно.',
    region: 'Владение', land: 'Земля', forest: 'Лес', hills: 'Высоты', selected: 'Выбрано', changeRegion: 'Сменить владение',
    chooseSite: 'Выберите клетку на карте', validSite: 'Подходящее место для замка', invalidSite: 'Здесь нельзя основать замок', confirm: 'Подтвердить основание',
  },
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
    mapHint: 'Перетащите карту · колесо — масштаб · Shift — владения · ПКМ / Ctrl + клик — меню',
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
    mainMenu: 'В главное меню',
    mainMenuDescription: 'Текущая партия пока не сохраняется',
  },
  generator: {
    title: 'Генератор мира', close: 'Закрыть генератор', devLabel: 'DEV · НАСТРОЙКИ',
    relief: 'Рельеф', mapSize: 'Размер карты', source: 'Источник', automatic: 'Полностью автоматически', hybrid: 'Авто + ручные узлы', manual: 'Преимущественно вручную',
    hills: 'Холмы и высоты', peaks: 'Непроходимые пики', formScale: 'Масштаб форм', reliefDistribution: 'К краям ← рельеф → к центру',
    vegetation: 'Растительность', coverage: 'Покрытие', vegetationDistribution: 'К краям ← зелень → к центру', heightPreference: 'Предпочтение высоты',
    lowlands: 'Низины', balanced: 'Средние высоты', highlands: 'Возвышенности', reliefInfluence: 'Влияние рельефа',
    brushAria: 'Кисть рельефа', erase: 'Стереть', hill: 'Холм', mountain: 'Гора', clearNodes: 'Очистить узлы', previewAria: 'Превью карты и редактор крупных форм рельефа',
    plain: 'Равнина', elevation: 'Высота', forest: 'Лес', peak: 'Пик', seed: 'Семя генерации',
    traversableHeights: 'Проходимые высоты', impassablePeaks: 'Непроходимые пики', forestCoverage: 'Лесное покрытие', cells: 'клеток',
    note: 'Рисуйте крупные узлы на превью. Они плавно распространяются на реальные клетки; лес избегает непроходимых пиков и крутых склонов.',
    participants: 'Стартовые владения', regionsCalculating: 'Рассчитываем границы владений…', regionsError: 'Для этих настроек недостаточно пригодной земли', regionsUnbalanced: 'Не удалось честно разделить владения — измените рельеф или семя',
    newVariant: 'Новый вариант', mapName: 'Название карты', defaultMapName: 'Моя карта', saveMap: 'Сохранить в мои карты', apply: 'Перейти к выбору владения',
  },
}

export default ru
