# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Dependencias del ayuntamiento (capturistas).** Personal de cada departamento que registra el avance mensual de sus proyectos. El sistema se pensó para usarse en PC y laptop de oficina. No está confirmado si alguien lo usa desde celular.
- **Administración central / presidencia (rol ADMIN).** Revisa lo que reportan todas las dependencias.
- **SuperAdmin.** Administra el catálogo: crea y borra departamentos y proyectos, ajusta presupuestos y corrige o elimina reportes.

## Product Purpose

Sistema de seguimiento del Programa Operativo Anual (POA) 2026 del H. Ayuntamiento de Morelos, Zacatecas. Cada dependencia reporta mes a mes el avance físico (%), el dinero gastado y las evidencias de sus proyectos; la administración central usa esa información para tres cosas:

1. Vigilar el gasto y el presupuesto: cuánto lleva cada dependencia y quién se excedió.
2. Dar seguimiento al avance: qué proyectos van atrasados o no han reportado.
3. Rendir cuentas: generar reportes e imprimir evidencias.

El éxito es que las dependencias puedan reportar sin trabas y que la administración vea de un vistazo el estado real de gasto y avance.

## Operating Context

- Flujo por rol tras iniciar sesión: dependencias van a la captura, ADMIN al resumen de presidencia (y de ahí al tablero y al reporte por departamento), SuperAdmin a su panel.
- El reporte es mensual y por proyecto: mes, avance físico del periodo, gasto del periodo, observaciones, responsable, correo y hasta 10 evidencias (fotos o PDF).
- El reporte por departamento está hecho para imprimirse.
- Un reporte enviado no lo puede corregir la dependencia; solo el SuperAdmin lo edita o borra.

## Capabilities and Constraints

- **El gasto no tiene tope.** Una dependencia puede reportar gasto aunque supere su presupuesto, y aunque el proyecto ya esté al 100% de avance físico.
- **El avance físico acumulado no pasa de 100%.**
- **El presupuesto solo lo ve la administración.** Las dependencias ven lo gastado y su avance, no el presupuesto autorizado. El administrador ve presupuesto, gastado y excedente; si el proyecto no tiene presupuesto asignado, ve el total gastado.
- Muchos proyectos no tienen presupuesto asignado (presupuesto en 0); es un estado normal, no un error.
- Las credenciales del login van siempre prellenadas, a petición del cliente.
- Técnica: Node/Express, PostgreSQL, páginas HTML estáticas sin framework ni build, evidencias en Cloudinary.
- Términos del dominio: POA, dependencia/departamento, proyecto, avance físico, avance financiero (gasto), evidencia, presupuesto autorizado, excedido.
- **Sin decidir:** si debe funcionar bien en celular.

## Brand Commitments

Ningún elemento visual es obligatorio: el logo, el verde y el aspecto actual pueden cambiarse. Lo único comprometido es que sea legible y fácil de usar.

## Evidence on Hand

- Datos reales en la base de producción: alrededor de 140 proyectos, parte sin presupuesto y algunos excedidos.
- Logo en `public/logo.jpeg`.
- No hay manual de identidad, guía de estilo ni textos institucionales aprobados; no inventarlos.

## Product Principles

1. **Reportar nunca se bloquea.** Ninguna regla de presupuesto impide a una dependencia registrar lo que hizo y gastó; los excesos se muestran, no se prohíben.
2. **Legible y fácil antes que vistoso.** Lo usan personas de oficina, no técnicas; cada pantalla se entiende sin instrucciones.
3. **Cada rol ve lo que le toca.** El presupuesto y los excesos son información de la administración, no de quien captura.
4. **Los números son la verdad.** Presupuesto, gasto y excedente se muestran exactos y sin ambigüedad, porque sirven para rendir cuentas.

## Accessibility & Inclusion

Legibilidad y facilidad de uso son el requisito explícito del cliente. No se estableció un estándar formal (como WCAG).
