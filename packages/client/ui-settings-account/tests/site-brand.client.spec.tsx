// @vitest-environment jsdom
/** Website marks never fall back to upstream artwork. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { ComponentProps } from 'react'
import { SiteBrandMark, SiteBrandName } from '../src/client/SiteBrand.tsx'

afterEach(() => { cleanup(); document.querySelector('meta[name="dsh-product-title"]')?.remove() })
const brand = { name: 'A very long independent website name', logo: 'https://site.invalid/logo.svg', docsUrl: '' }
const props: ComponentProps<typeof SiteBrandMark> = {
  size: 34,
  useAccount: selector => selector({ view: { status: 'signed-out', attempt: null, brand,
    links: { usageUrl: 'https://site.invalid/', topUpUrl: 'https://site.invalid/' } }, failed: false, details: undefined, avatar: undefined }),
  useTheme: () => { throw new Error('brand rendering does not read theme state') },
}
it('keeps the complete name and replaces a broken logo with the site initial', () => {
  const view = render(<><SiteBrandMark {...props} /><SiteBrandName {...props} /></>)
  expect(view.getByTitle(brand.name).textContent).toBe(brand.name)
  const image = view.container.querySelector('img')!
  expect(image.getAttribute('src')).toBe(brand.logo)
  fireEvent.error(image)
  expect(view.container.querySelector('img')).toBeNull()
  expect(view.getByText('A')).toBeTruthy()
  expect(view.container.querySelector('svg')).toBeNull()
})
it('uses a site initial when no logo is configured', () => {
  const view = render(<SiteBrandMark {...props} useAccount={selector => selector({ view: {
    status: 'signed-out', attempt: null, brand: { ...brand, logo: '' }, links: { usageUrl: '', topUpUrl: '' },
  }, failed: false, details: undefined, avatar: undefined })} />)
  expect(view.container.querySelector('img')).toBeNull()
  expect(view.getByText('A')).toBeTruthy()
})

it('keeps the native product name and artwork for Desktop website accounts', () => {
  const meta = document.createElement('meta')
  meta.name = 'dsh-product-title'
  meta.content = 'Altoai Harness'
  document.head.append(meta)
  const view = render(<><SiteBrandMark {...props} /><SiteBrandName {...props} /></>)
  expect(view.getByTitle('Altoai Harness').textContent).toBe('Altoai Harness')
  expect(view.container.querySelector('img')?.getAttribute('src')).toBe('/assets/altoai-mark.png')
})
