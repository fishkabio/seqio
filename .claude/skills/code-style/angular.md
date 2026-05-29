# Angular Code Style

- Use Angular v20 syntax for templates
- Use Material v3 (example: never use mat-*-button, use matButton) and @angular/aria.
- In Angular code prefer using @angular/aria instead of @angular/material for UI components when possible.
- Use OnPush change detection strategy
- Use snake_case for class names
- Prefer using a new signals syntax instead of @Input()
- Use @if insted if *ngIf
- For CSS styles, use constants from the 'colors' and 'fonts' SCSS files and always verify that the constants exist in
  these files.
- In this project we only use outline styled form fields
- In this project we do not use text or elevated material buttons
