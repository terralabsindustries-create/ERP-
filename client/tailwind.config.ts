import type { Config } from "tailwindcss";

export default {
	darkMode: ["class"],
	content: [
		"./pages/**/*.{ts,tsx}",
		"./components/**/*.{ts,tsx}",
		"./app/**/*.{ts,tsx}",
		"./src/**/*.{ts,tsx}",
	],
	prefix: "",
	theme: {
		container: {
			center: true,
			padding: '2rem',
			screens: {
				'2xl': '1400px'
			}
		},
		extend: {
			colors: {
				border: 'hsl(var(--border))',
				input: 'hsl(var(--input))',
				ring: 'hsl(var(--ring))',
				background: 'hsl(var(--background))',
				foreground: 'hsl(var(--foreground))',
				primary: {
					DEFAULT: 'hsl(var(--primary))',
					foreground: 'hsl(var(--primary-foreground))',
					hover: 'hsl(var(--primary-hover))',
					glow: 'hsl(var(--primary-glow))',
					soft: 'hsl(var(--primary-soft))',
					strong: 'hsl(var(--primary-strong))'
				},
				secondary: {
					DEFAULT: 'hsl(var(--secondary))',
					foreground: 'hsl(var(--secondary-foreground))'
				},
				destructive: {
					DEFAULT: 'hsl(var(--destructive))',
					foreground: 'hsl(var(--destructive-foreground))',
					soft: 'hsl(var(--destructive-soft))',
					strong: 'hsl(var(--destructive-strong))'
				},
				muted: {
					DEFAULT: 'hsl(var(--muted))',
					foreground: 'hsl(var(--muted-foreground))'
				},
				accent: {
					DEFAULT: 'hsl(var(--accent))',
					foreground: 'hsl(var(--accent-foreground))'
				},
				success: {
					DEFAULT: 'hsl(var(--success))',
					foreground: 'hsl(var(--success-foreground))',
					soft: 'hsl(var(--success-soft))',
					strong: 'hsl(var(--success-strong))'
				},
				warning: {
					DEFAULT: 'hsl(var(--warning))',
					foreground: 'hsl(var(--warning-foreground))',
					soft: 'hsl(var(--warning-soft))',
					strong: 'hsl(var(--warning-strong))'
				},
				urgent: {
					DEFAULT: 'hsl(var(--urgent))',
					foreground: 'hsl(var(--urgent-foreground))'
				},
				pending: {
					DEFAULT: 'hsl(var(--pending))',
					foreground: 'hsl(var(--pending-foreground))'
				},
				completed: {
					DEFAULT: 'hsl(var(--completed))',
					foreground: 'hsl(var(--completed-foreground))'
				},
				walkin: {
					DEFAULT: 'hsl(var(--walkin))',
					foreground: 'hsl(var(--walkin-foreground))'
				},
				corporate: {
					DEFAULT: 'hsl(var(--corporate))',
					foreground: 'hsl(var(--corporate-foreground))'
				},
				popover: {
					DEFAULT: 'hsl(var(--popover))',
					foreground: 'hsl(var(--popover-foreground))'
				},
				card: {
					DEFAULT: 'hsl(var(--card))',
					foreground: 'hsl(var(--card-foreground))'
				},
				info: {
					DEFAULT: 'hsl(var(--info))',
					foreground: 'hsl(var(--info-foreground))',
					soft: 'hsl(var(--info-soft))',
					strong: 'hsl(var(--info-strong))'
				},
				cmyk: {
					c: 'hsl(var(--cmyk-c))',
					m: 'hsl(var(--cmyk-m))',
					y: 'hsl(var(--cmyk-y))',
					k: 'hsl(var(--cmyk-k))'
				},
				sidebar: {
					DEFAULT: 'hsl(var(--sidebar-background))',
					foreground: 'hsl(var(--sidebar-foreground))',
					muted: 'hsl(var(--sidebar-muted))',
					primary: 'hsl(var(--sidebar-primary))',
					'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
					accent: 'hsl(var(--sidebar-accent))',
					'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
					border: 'hsl(var(--sidebar-border))',
					ring: 'hsl(var(--sidebar-ring))'
				},
				chart: {
					1: 'hsl(var(--chart-1))',
					2: 'hsl(var(--chart-2))',
					3: 'hsl(var(--chart-3))',
					4: 'hsl(var(--chart-4))',
					5: 'hsl(var(--chart-5))'
				},
				// Carbon tokens by their own names (src/index.css). They follow the theme.
				paper: {
					DEFAULT: 'hsl(var(--paper))',
					2: 'hsl(var(--paper-2))',
					3: 'hsl(var(--paper-3))'
				},
				ink: {
					DEFAULT: 'hsl(var(--ink))',
					2: 'hsl(var(--ink-2))',
					3: 'hsl(var(--ink-3))'
				},
				line: {
					DEFAULT: 'hsl(var(--line))',
					strong: 'hsl(var(--line-strong))'
				},
				brand: {
					DEFAULT: 'hsl(var(--brand))',
					hover: 'hsl(var(--brand-hover))',
					soft: 'hsl(var(--brand-soft))',
					fg: 'hsl(var(--brand-fg))',
					cream: 'hsl(var(--brand-cream))'
				},
				amber: {
					DEFAULT: 'hsl(var(--amber))',
					hover: 'hsl(var(--amber-hover))',
					soft: 'hsl(var(--amber-soft))'
				},
				peach: 'hsl(var(--peach))',
				lime: 'hsl(var(--lime))',
				lilac: 'hsl(var(--lilac))',
				phase: {
					sales: { DEFAULT: 'hsl(var(--phase-sales))', text: 'hsl(var(--phase-sales-text))' },
					prepress: { DEFAULT: 'hsl(var(--phase-prepress))', text: 'hsl(var(--phase-prepress-text))' },
					press: { DEFAULT: 'hsl(var(--phase-press))', text: 'hsl(var(--phase-press-text))' },
					postpress: { DEFAULT: 'hsl(var(--phase-postpress))', text: 'hsl(var(--phase-postpress-text))' },
					dispatch: { DEFAULT: 'hsl(var(--phase-dispatch))', text: 'hsl(var(--phase-dispatch-text))' }
				},
				danger: {
					DEFAULT: 'hsl(var(--destructive))',
					soft: 'hsl(var(--danger-bg))',
					strong: 'hsl(var(--danger-fg))',
					border: 'hsl(var(--danger-border))'
				},
				night: {
					DEFAULT: 'hsl(var(--night))',
					2: 'hsl(var(--night-2))',
					3: 'hsl(var(--night-3))',
					tint: 'hsl(var(--night-tint))',
					line: 'var(--night-line)',
					text: 'hsl(var(--night-text))',
					muted: 'hsl(var(--night-muted))'
				},
				whatsapp: {
					DEFAULT: 'hsl(var(--whatsapp))',
					strong: 'hsl(var(--whatsapp-strong))'
				}
			},
			borderRadius: {
				// --radius is 10px: lg 10px (buttons, inputs), xl 14px (cards, = --radius-md)
				xl: 'calc(var(--radius) + 4px)',
				lg: 'var(--radius)',
				md: 'calc(var(--radius) - 2px)',
				sm: 'calc(var(--radius) - 4px)'
			},
			keyframes: {
				'accordion-down': {
					from: { height: '0' },
					to: { height: 'var(--radix-accordion-content-height)' }
				},
				'accordion-up': {
					from: { height: 'var(--radix-accordion-content-height)' },
					to: { height: '0' }
				},
				'fade-in': {
					'0%': { opacity: '0', transform: 'translateY(10px)' },
					'100%': { opacity: '1', transform: 'translateY(0)' }
				},
				'fade-up': {
					'0%': { opacity: '0', transform: 'translateY(20px)' },
					'100%': { opacity: '1', transform: 'translateY(0)' }
				},
				'scale-in': {
					'0%': { transform: 'scale(0.95)', opacity: '0' },
					'100%': { transform: 'scale(1)', opacity: '1' }
				},
				'scale-up': {
					'0%': { transform: 'scale(0.9)', opacity: '0' },
					'100%': { transform: 'scale(1)', opacity: '1' }
				},
				'slide-up': {
					'0%': { transform: 'translateY(100%)', opacity: '0' },
					'100%': { transform: 'translateY(0)', opacity: '1' }
				},
				'slide-down': {
					'0%': { transform: 'translateY(-100%)', opacity: '0' },
					'100%': { transform: 'translateY(0)', opacity: '1' }
				},
				'slide-right': {
					'0%': { transform: 'translateX(-100%)', opacity: '0' },
					'100%': { transform: 'translateX(0)', opacity: '1' }
				},
				'bounce-gentle': {
					'0%, 20%, 50%, 80%, 100%': { transform: 'translateY(0)' },
					'40%': { transform: 'translateY(-5px)' },
					'60%': { transform: 'translateY(-3px)' }
				},
				'glow-pulse': {
					'0%, 100%': { boxShadow: '0 0 20px hsl(var(--primary) / 0.2)' },
					'50%': { boxShadow: '0 0 30px hsl(var(--primary) / 0.4)' }
				},
				'float': {
					'0%, 100%': { transform: 'translateY(0px)' },
					'50%': { transform: 'translateY(-10px)' }
				},
				'wiggle': {
					'0%, 100%': { transform: 'rotate(-3deg)' },
					'50%': { transform: 'rotate(3deg)' }
				},
				'shimmer': {
					'0%': { backgroundPosition: '-200% 0' },
					'100%': { backgroundPosition: '200% 0' }
				}
			},
			animation: {
				'accordion-down': 'accordion-down 0.2s ease-out',
				'accordion-up': 'accordion-up 0.2s ease-out',
				'fade-in': 'fade-in 0.5s ease-out',
				'fade-up': 'fade-up 0.6s ease-out',
				'scale-in': 'scale-in 0.3s ease-out',
				'scale-up': 'scale-up 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
				'slide-up': 'slide-up 0.4s ease-out',
				'slide-down': 'slide-down 0.4s ease-out',
				'slide-right': 'slide-right 0.4s ease-out',
				'bounce-gentle': 'bounce-gentle 2s infinite',
				'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
				'float': 'float 3s ease-in-out infinite',
				'wiggle': 'wiggle 1s ease-in-out infinite',
				'shimmer': 'shimmer 2s linear infinite'
			},
			backgroundImage: {
				'gradient-primary': 'var(--gradient-primary)',
				'gradient-secondary': 'var(--gradient-secondary)',
				'gradient-accent': 'var(--gradient-accent)',
				'gradient-success': 'var(--gradient-success)',
				'gradient-warning': 'var(--gradient-warning)',
				'gradient-card': 'var(--gradient-card)',
				'gradient-glass': 'var(--gradient-glass)',
				'gradient-hero': 'var(--gradient-hero)',
				'shimmer-gradient': 'linear-gradient(90deg, transparent, hsl(var(--card) / 0.2), transparent)',
				'signature': 'var(--signature)'
			},
			// Warm brown shadows only; Tailwind's grey defaults are replaced too.
			boxShadow: {
				sm: 'var(--shadow-sm)',
				DEFAULT: 'var(--shadow)',
				md: 'var(--shadow)',
				lg: 'var(--shadow-lg)',
				xl: 'var(--shadow-lg)',
				'card': 'var(--shadow-card)',
				'modal': 'var(--shadow-modal)',
				'brand': 'var(--shadow-brand)',
				'rush': 'var(--shadow-rush)',
				'ring': 'var(--focus-ring)',
				'elevated': 'var(--shadow-elevated)',
				'glow': 'var(--shadow-glow)',
				'float': 'var(--shadow-float)',
				'inner': 'var(--shadow-inner)'
			},
			fontFamily: {
				// Bundled with @fontsource (src/fonts.ts), so the desktop app works offline
				'sans': ['var(--font-body)'],
				'display': ['var(--font-display)'],
				'mono': ['var(--font-mono)']
			}
		}
	},
	plugins: [require("tailwindcss-animate")],
} satisfies Config;
