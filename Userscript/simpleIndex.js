//Ref:https://scrapbox.io/scrapboxlab/強調記法からページの見出しを作るUserScript

const boldDeco = "[* "
const boldDeco2 = "[** "
const marginLeftIndent = "● "
const marginLeftIndent2 = " ○ "
 scrapbox.PageMenu.addMenu({
     title: '見出し',
     image: 'https://gyazo.com/da0408108eda84e56a587630be5e4524/raw',
     onClick: () => {
         scrapbox.PageMenu('見出し').removeAllItems()
         for (let line of scrapbox.Page.lines) {
             if (!line.section.start) continue
             if (!line.text.startsWith(boldDeco) && !line.text.startsWith(boldDeco2)) continue
             if (!line.nodes) continue
             const image = ""
             const noIcon = false
             // [* hoge]と[** hoge]は先頭をインデントする。
             const marginLeft = line.text.startsWith(boldDeco) ? marginLeftIndent : ""
             const marginLeft2 = line.text.startsWith(boldDeco2) ? marginLeftIndent2 : ""
             const title = marginLeft + marginLeft2 +  renderPlainText(line.nodes)
             const onClick = () => location.hash = line.id
             scrapbox.PageMenu('見出し').addItem({ title, image, onClick })
         }
     }
 })

const indexes = function () {
  scrapbox.PageMenu('見出し').removeAllItems()
  for (let line of scrapbox.Page.lines) {
    if (!line.section.start || line.title) continue
    const image = line.nodes && getIconUrl(line.nodes)
    const noIcon = !!image
    const title = line.nodes ? renderPlainText(line.nodes, {noIcon}) : line.text
    const onClick = () => location.hash = line.id
    scrapbox.PageMenu('見出し').addItem({title, image, onClick})
  }
}

function renderPlainText (node, options) {
  if (node instanceof Array) return node.map(node => renderPlainText(node, options)).join('')
  if (typeof node === 'string') return node
  switch (node.type) {
    case 'icon':
    case 'strong-icon':
      return options.noIcon ? ' ' : node.unit.page
    case 'hashTag':
      return ''
  }
  return renderPlainText(node.children, options)
}

function getIconUrl (node) {
  if (/icon/.test(node.type)) {
    return `/api/pages/${node.unit.project || scrapbox.Project.name}/${node.unit.page}/icon`
  }
  if (node instanceof Array) {
    return node.map(getIconUrl).find(img => img)
  }
  return null
}
